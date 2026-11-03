/**
 * 인증 모듈
 * - 학생 로그인과 관리자 로그인을 분리한다 (테이블, 엔드포인트, 세션 subject_type 모두 분리).
 * - 비밀번호는 PBKDF2-SHA256으로 해시하여 비교한다.
 * - 세션 토큰은 무작위 32바이트이며 DB에는 SHA-256 해시만 저장한다.
 * - 라즈베리파이 장치는 DEVICE_TOKEN 비밀 값(wrangler secret)으로 인증한다.
 *
 * 주의: 학번+이름만으로 본인 확인이 된다고 가정하지 않는다. 반드시 비밀 정보가 필요하다.
 * TODO: 로그인 시도 횟수 제한(rate limit), 학교 SSO 연동, 학생 계정 발급 절차.
 */
import { HttpError, json, readJson, nowIso, logEvent } from './router.js';

// Cloudflare Workers의 PBKDF2 최대 반복 횟수는 100,000회이다.
const PBKDF2_ITERATIONS = 100_000;
const encoder = new TextEncoder();

function toBase64(bytes) {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(text) {
  const binary = atob(text);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function toBase64Url(bytes) {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

async function sha256Hex(text) {
  return [...(await sha256(text))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

/** 비밀번호 해시 생성 (계정 발급 도구에서 사용 예정) */
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2_sha256$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 10_000 || iterations > 100_000) return false;
  try {
    const expected = fromBase64(parts[3]);
    const actual = await pbkdf2(password, fromBase64(parts[2]), iterations);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// 존재하지 않는 계정에 대해서도 동일한 연산 시간을 소모하기 위한 더미 해시
const DUMMY_HASH = `pbkdf2_sha256$${PBKDF2_ITERATIONS}$${toBase64(new Uint8Array(16))}$${toBase64(new Uint8Array(32))}`;

function bearerToken(request) {
  const header = request.headers.get('Authorization') || '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match ? match[1] : null;
}

async function createSession(env, subjectType, subjectId) {
  const token = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const ttlHours = Number(env.SESSION_TTL_HOURS) > 0 ? Number(env.SESSION_TTL_HOURS) : 12;
  const now = new Date();
  const expiresAt = nowIso(new Date(now.getTime() + ttlHours * 3600_000));
  await env.DB.prepare(
    `INSERT INTO sessions (token_hash, subject_type, subject_id, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  ).bind(await sha256Hex(token), subjectType, subjectId, nowIso(now), expiresAt).run();
  return { token, expiresAt };
}

/**
 * Bearer 토큰으로 세션을 확인한다.
 * @param {'student'|'admin'|null} subjectType null이면 종류 무관
 */
export async function authenticate(request, env, subjectType) {
  const token = bearerToken(request);
  if (!token) throw new HttpError(401, 'unauthenticated', '로그인이 필요합니다.');

  const row = await env.DB.prepare(
    `SELECT id, subject_type, subject_id FROM sessions
     WHERE token_hash = ?1 AND revoked_at IS NULL AND expires_at > ?2`,
  ).bind(await sha256Hex(token), nowIso()).first();
  if (!row) throw new HttpError(401, 'session_invalid', '세션이 만료되었거나 올바르지 않습니다.');

  if (subjectType && row.subject_type !== subjectType) {
    throw new HttpError(403, 'forbidden', '이 작업을 수행할 권한이 없습니다.');
  }

  // 테이블 이름은 고정된 두 값 중 하나에서만 선택된다 (사용자 입력 아님).
  const table = row.subject_type === 'admin' ? 'admins' : 'students';
  const subject = await env.DB.prepare(`SELECT id FROM ${table} WHERE id = ?1 AND is_active = 1`)
    .bind(row.subject_id).first();
  if (!subject) throw new HttpError(401, 'account_inactive', '사용할 수 없는 계정입니다.');

  return { sessionId: row.id, subjectType: row.subject_type, subjectId: row.subject_id };
}

export const requireStudent = ({ request, env }) => authenticate(request, env, 'student');
export const requireAdmin = ({ request, env }) => authenticate(request, env, 'admin');

/** 라즈베리파이 장치 인증. DEVICE_TOKEN이 설정되지 않으면 모든 장치 요청을 거부한다(fail-closed). */
export async function requireDevice({ request, env }) {
  if (!env.DEVICE_TOKEN) {
    throw new HttpError(503, 'device_auth_not_configured', '장치 인증이 설정되지 않았습니다.');
  }
  const token = bearerToken(request);
  if (!token) throw new HttpError(401, 'unauthenticated', '장치 토큰이 필요합니다.');
  const [given, expected] = await Promise.all([sha256(token), sha256(env.DEVICE_TOKEN)]);
  if (!timingSafeEqual(given, expected)) {
    throw new HttpError(401, 'device_token_invalid', '장치 토큰이 올바르지 않습니다.');
  }
  const deviceId = (request.headers.get('X-Device-Id') || 'unknown').slice(0, 64);
  return { deviceId };
}

function readCredentials(body, idField, idPattern) {
  const id = typeof body[idField] === 'string' ? body[idField].trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!idPattern.test(id) || password.length < 1 || password.length > 128) {
    throw new HttpError(400, 'invalid_credentials_format', '로그인 정보 형식이 올바르지 않습니다.');
  }
  return { id, password };
}

export async function handleStudentLogin({ request, env }) {
  const { id: studentNo, password } = readCredentials(await readJson(request), 'student_no', /^[A-Za-z0-9-]{1,32}$/);

  const student = await env.DB.prepare(
    'SELECT id, display_name, password_hash FROM students WHERE student_no = ?1 AND is_active = 1',
  ).bind(studentNo).first();

  const passwordOk = await verifyPassword(password, student?.password_hash ?? DUMMY_HASH);
  if (!student || !passwordOk) {
    // 존재하지 않는 학번은 기록하지 않는다 (개인정보/계정 열거 방지)
    await logEvent(env, {
      source: 'web',
      eventType: 'auth.student_login_failed',
      actorType: student ? 'student' : null,
      actorId: student?.id ?? null,
    });
    throw new HttpError(401, 'invalid_credentials', '학번 또는 비밀번호가 올바르지 않습니다.');
  }

  const session = await createSession(env, 'student', student.id);
  await logEvent(env, { source: 'web', eventType: 'auth.student_login', actorType: 'student', actorId: student.id });
  return json({
    token: session.token,
    expires_at: session.expiresAt,
    user: { type: 'student', id: student.id, display_name: student.display_name },
  });
}

export async function handleAdminLogin({ request, env }) {
  const { id: username, password } = readCredentials(await readJson(request), 'username', /^[A-Za-z0-9_.-]{3,32}$/);

  const admin = await env.DB.prepare(
    'SELECT id, username, password_hash FROM admins WHERE username = ?1 AND is_active = 1',
  ).bind(username).first();

  const passwordOk = await verifyPassword(password, admin?.password_hash ?? DUMMY_HASH);
  if (!admin || !passwordOk) {
    await logEvent(env, {
      source: 'admin',
      eventType: 'auth.admin_login_failed',
      actorType: admin ? 'admin' : null,
      actorId: admin?.id ?? null,
    });
    throw new HttpError(401, 'invalid_credentials', '아이디 또는 비밀번호가 올바르지 않습니다.');
  }

  const session = await createSession(env, 'admin', admin.id);
  await logEvent(env, { source: 'admin', eventType: 'auth.admin_login', actorType: 'admin', actorId: admin.id });
  return json({
    token: session.token,
    expires_at: session.expiresAt,
    user: { type: 'admin', id: admin.id, username: admin.username },
  });
}

export async function handleLogout({ request, env }) {
  const auth = await authenticate(request, env, null);
  await env.DB.prepare('UPDATE sessions SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL')
    .bind(nowIso(), auth.sessionId).run();
  await logEvent(env, {
    source: auth.subjectType === 'admin' ? 'admin' : 'web',
    eventType: 'auth.logout',
    actorType: auth.subjectType,
    actorId: auth.subjectId,
  });
  return json({ ok: true });
}

export async function handleMe({ request, env }) {
  const auth = await authenticate(request, env, null);
  if (auth.subjectType === 'admin') {
    const admin = await env.DB.prepare('SELECT id, username FROM admins WHERE id = ?1').bind(auth.subjectId).first();
    return json({ user: { type: 'admin', id: admin.id, username: admin.username } });
  }
  const student = await env.DB.prepare('SELECT id, display_name FROM students WHERE id = ?1').bind(auth.subjectId).first();
  return json({ user: { type: 'student', id: student.id, display_name: student.display_name } });
}
