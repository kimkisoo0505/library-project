#!/usr/bin/env node
/**
 * 학생 / 관리자 계정 관리 CLI
 *
 * 비밀번호 해시는 서버(workers/auth.js)의 hashPassword() 를 그대로 사용하므로
 * 서버 로그인 검증 형식과 항상 일치한다. 입력 형식 규칙도 auth.js 와 공유한다.
 *
 * 사용법 (cloudflare 디렉터리에서):
 *   node scripts/accounts.mjs create-student <학번> <표시이름>  [옵션]
 *   node scripts/accounts.mjs create-admin   <아이디>           [옵션]
 *   node scripts/accounts.mjs reset-password <student|admin> <학번|아이디> [옵션]
 *   node scripts/accounts.mjs deactivate     <student|admin> <학번|아이디> [옵션]
 *   node scripts/accounts.mjs list                              [옵션]
 *
 * 옵션:
 *   --local            로컬 D1 (기본값)
 *   --remote --yes     운영 D1 (Cloudflare). --yes 없이는 실행하지 않음
 *   --password-stdin   표준 입력에서 비밀번호를 읽음 (없으면 무작위 비밀번호 생성)
 *
 * 주의: 실제 학생 개인정보를 테스트 용도로 입력하지 말 것 (CLAUDE.md 규칙 5).
 */
import { spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  hashPassword,
  STUDENT_NO_PATTERN,
  ADMIN_USERNAME_PATTERN,
  PASSWORD_MAX_LENGTH,
} from '../workers/auth.js';

export const DATABASE_NAME = 'library-seat-db';
export const PASSWORD_MIN_LENGTH = 8;
export const DISPLAY_NAME_PATTERN = /^[\p{L}\p{N} ._-]{1,40}$/u;
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const CLOUDFLARE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export class UsageError extends Error {}

// ---------------------------------------------------------------- 검증 / SQL

export function validateStudentNo(value) {
  if (!STUDENT_NO_PATTERN.test(value ?? '')) {
    throw new UsageError('학번 형식 오류: 영문/숫자/하이픈 1~32자 (예: TEST-0001)');
  }
  return value;
}

export function validateUsername(value) {
  if (!ADMIN_USERNAME_PATTERN.test(value ?? '')) {
    throw new UsageError('관리자 아이디 형식 오류: 영문/숫자/_ . - 3~32자');
  }
  return value;
}

export function validateDisplayName(value) {
  const name = String(value ?? '').trim();
  if (!DISPLAY_NAME_PATTERN.test(name)) {
    throw new UsageError('표시 이름 형식 오류: 글자/숫자/공백/._- 1~40자');
  }
  return name;
}

export function validatePassword(value) {
  if (typeof value !== 'string' || value.length < PASSWORD_MIN_LENGTH || value.length > PASSWORD_MAX_LENGTH) {
    throw new UsageError(`비밀번호는 ${PASSWORD_MIN_LENGTH}~${PASSWORD_MAX_LENGTH}자여야 합니다.`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new UsageError('비밀번호에 제어 문자를 사용할 수 없습니다.');
  return value;
}

export function generatePassword(length = 12) {
  let out = '';
  for (let i = 0; i < length; i += 1) out += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
  return out;
}

/**
 * SQL 문자열 리터럴. `wrangler d1 execute --command` 는 바인딩 파라미터를 지원하지 않으므로
 * (1) 모든 값을 위의 엄격한 형식 검증으로 먼저 걸러내고 (2) 작은따옴표를 이중화한다.
 */
export function sqlString(value) {
  const text = String(value);
  if (/[\u0000]/.test(text)) throw new UsageError('NUL 문자는 허용되지 않습니다.');
  return `'${text.replace(/'/g, "''")}'`;
}

function eventSql(eventType, table, whereColumn, whereValue) {
  return `INSERT INTO events (occurred_at, source, event_type, actor_type, actor_id, payload)
SELECT ${NOW_SQL}, 'system', ${sqlString(eventType)}, 'system', 'cli', json_object('subject_id', id)
  FROM ${table} WHERE ${whereColumn} = ${sqlString(whereValue)};`;
}

const SUBJECTS = {
  student: { table: 'students', column: 'student_no', validate: validateStudentNo, hasUpdatedAt: true },
  admin: { table: 'admins', column: 'username', validate: validateUsername, hasUpdatedAt: false },
};

function subjectOf(kind) {
  const subject = SUBJECTS[kind];
  if (!subject) throw new UsageError('대상은 student 또는 admin 이어야 합니다.');
  return subject;
}

export function buildCreateStudentSql(studentNo, displayName, passwordHash) {
  return [
    `INSERT INTO students (student_no, display_name, password_hash) VALUES (${sqlString(studentNo)}, ${sqlString(displayName)}, ${sqlString(passwordHash)});`,
    eventSql('account.student_created', 'students', 'student_no', studentNo),
  ].join('\n');
}

export function buildCreateAdminSql(username, passwordHash) {
  return [
    `INSERT INTO admins (username, password_hash) VALUES (${sqlString(username)}, ${sqlString(passwordHash)});`,
    eventSql('account.admin_created', 'admins', 'username', username),
  ].join('\n');
}

function revokeSessionsSql(kind, subject, id) {
  return `UPDATE sessions SET revoked_at = ${NOW_SQL}
 WHERE subject_type = ${sqlString(kind)} AND revoked_at IS NULL
   AND subject_id IN (SELECT id FROM ${subject.table} WHERE ${subject.column} = ${sqlString(id)});`;
}

export function buildResetPasswordSql(kind, id, passwordHash) {
  const subject = subjectOf(kind);
  const updatedAt = subject.hasUpdatedAt ? `, updated_at = ${NOW_SQL}` : '';
  return [
    `UPDATE ${subject.table} SET password_hash = ${sqlString(passwordHash)}${updatedAt} WHERE ${subject.column} = ${sqlString(id)} RETURNING id;`,
    revokeSessionsSql(kind, subject, id),
    eventSql(`account.${kind}_password_reset`, subject.table, subject.column, id),
  ].join('\n');
}

export function buildDeactivateSql(kind, id) {
  const subject = subjectOf(kind);
  const updatedAt = subject.hasUpdatedAt ? `, updated_at = ${NOW_SQL}` : '';
  return [
    `UPDATE ${subject.table} SET is_active = 0${updatedAt} WHERE ${subject.column} = ${sqlString(id)} AND is_active = 1 RETURNING id;`,
    revokeSessionsSql(kind, subject, id),
    eventSql(`account.${kind}_deactivated`, subject.table, subject.column, id),
  ].join('\n');
}

const LIST_SQL = [
  "SELECT 'student' AS type, id, student_no AS login_id, display_name, is_active, created_at FROM students ORDER BY id;",
  "SELECT 'admin' AS type, id, username AS login_id, NULL AS display_name, is_active, created_at FROM admins ORDER BY id;",
].join('\n');

// ---------------------------------------------------------------- 실행

export function parseArgs(argv) {
  const positional = [];
  const flags = new Set();
  for (const arg of argv) {
    if (arg.startsWith('--')) flags.add(arg);
    else positional.push(arg);
  }
  const known = new Set(['--local', '--remote', '--yes', '--password-stdin']);
  for (const flag of flags) if (!known.has(flag)) throw new UsageError(`알 수 없는 옵션: ${flag}`);
  if (flags.has('--local') && flags.has('--remote')) throw new UsageError('--local 과 --remote 는 함께 쓸 수 없습니다.');
  return { command: positional[0], args: positional.slice(1), remote: flags.has('--remote'), yes: flags.has('--yes'), passwordStdin: flags.has('--password-stdin') };
}

function runD1(sql, { remote }) {
  const wrangler = join(CLOUDFLARE_ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const args = [wrangler, 'd1', 'execute', DATABASE_NAME, remote ? '--remote' : '--local', '--json', '--command', sql];
  const result = spawnSync(process.execPath, args, {
    cwd: CLOUDFLARE_ROOT,
    encoding: 'utf8',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  let parsed = null;
  try { parsed = JSON.parse(result.stdout); } catch { parsed = null; }
  if (result.status !== 0 || !Array.isArray(parsed)) {
    const detail = `${result.stdout}\n${result.stderr}`;
    if (/UNIQUE constraint failed/i.test(detail)) throw new UsageError('이미 존재하는 계정입니다.');
    throw new Error(`wrangler d1 execute 실패 (exit ${result.status}):\n${detail.trim()}`);
  }
  return parsed;
}

function readPassword(passwordStdin) {
  if (!passwordStdin) return { password: generatePassword(), generated: true };
  const text = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
  return { password: validatePassword(text), generated: false };
}

function printPassword(loginId, { password, generated }) {
  if (!generated) return;
  console.log(`\n  로그인 ID : ${loginId}\n  초기 비밀번호 : ${password}\n  (이 비밀번호는 다시 표시되지 않습니다. 안전한 곳에 보관하세요.)\n`);
}

const USAGE = `사용법:
  node scripts/accounts.mjs create-student <학번> <표시이름> [--remote --yes] [--password-stdin]
  node scripts/accounts.mjs create-admin <아이디> [--remote --yes] [--password-stdin]
  node scripts/accounts.mjs reset-password <student|admin> <학번|아이디> [--remote --yes] [--password-stdin]
  node scripts/accounts.mjs deactivate <student|admin> <학번|아이디> [--remote --yes]
  node scripts/accounts.mjs list [--remote]`;

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const target = opts.remote ? '운영(remote)' : '로컬(local)';
  const mutating = opts.command !== 'list';
  if (opts.remote && mutating && !opts.yes) {
    throw new UsageError('운영 DB를 변경하려면 --yes 를 함께 지정하세요.');
  }

  switch (opts.command) {
    case 'create-student': {
      if (opts.args.length !== 2) throw new UsageError(USAGE);
      const studentNo = validateStudentNo(opts.args[0]);
      const displayName = validateDisplayName(opts.args[1]);
      const pw = readPassword(opts.passwordStdin);
      runD1(buildCreateStudentSql(studentNo, displayName, await hashPassword(pw.password)), opts);
      console.log(`[${target}] 학생 계정 생성: ${studentNo} (${displayName})`);
      printPassword(studentNo, pw);
      return;
    }
    case 'create-admin': {
      if (opts.args.length !== 1) throw new UsageError(USAGE);
      const username = validateUsername(opts.args[0]);
      const pw = readPassword(opts.passwordStdin);
      runD1(buildCreateAdminSql(username, await hashPassword(pw.password)), opts);
      console.log(`[${target}] 관리자 계정 생성: ${username}`);
      printPassword(username, pw);
      return;
    }
    case 'reset-password':
    case 'deactivate': {
      if (opts.args.length !== 2) throw new UsageError(USAGE);
      const [kind, rawId] = opts.args;
      const id = subjectOf(kind).validate(rawId);
      let pw = null;
      let sql;
      if (opts.command === 'reset-password') {
        pw = readPassword(opts.passwordStdin);
        sql = buildResetPasswordSql(kind, id, await hashPassword(pw.password));
      } else {
        sql = buildDeactivateSql(kind, id);
      }
      const results = runD1(sql, opts);
      // 로컬 wrangler 는 meta.changes 를 주지 않으므로 RETURNING 결과로 대상 존재 여부를 판단한다
      if (!(results[0]?.results?.length > 0)) throw new UsageError(`대상 계정을 찾을 수 없거나 이미 처리되었습니다: ${kind} ${id}`);
      console.log(`[${target}] ${opts.command === 'deactivate' ? '비활성화' : '비밀번호 재설정'} 완료: ${kind} ${id} (기존 세션 무효화)`);
      if (pw) printPassword(id, pw);
      return;
    }
    case 'list': {
      const results = runD1(LIST_SQL, opts);
      const rows = results.flatMap((r) => r.results ?? []);
      console.log(`[${target}] 계정 ${rows.length}개`);
      if (rows.length) console.table(rows);
      return;
    }
    default:
      throw new UsageError(USAGE);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(err instanceof UsageError ? err.message : err);
    process.exit(err instanceof UsageError ? 2 : 1);
  });
}
