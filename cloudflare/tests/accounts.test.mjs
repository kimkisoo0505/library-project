// 계정 도구 및 비밀번호 해시 단위 테스트 (네트워크/D1 불필요)
// 실행: npm test  (cloudflare 디렉터리)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../workers/auth.js';
import {
  UsageError,
  buildCreateStudentSql,
  buildDeactivateSql,
  buildResetPasswordSql,
  generatePassword,
  parseArgs,
  sqlString,
  validateDisplayName,
  validatePassword,
  validateStudentNo,
  validateUsername,
} from '../scripts/accounts.mjs';

test('hashPassword 결과를 verifyPassword 가 검증한다', async () => {
  const hash = await hashPassword('correct horse battery');
  assert.match(hash, /^pbkdf2_sha256\$100000\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.equal(await verifyPassword('correct horse battery', hash), true);
  assert.equal(await verifyPassword('wrong password', hash), false);
  assert.equal(await verifyPassword('x', 'not-a-hash'), false);
});

test('같은 비밀번호도 매번 다른 salt 로 해시된다', async () => {
  assert.notEqual(await hashPassword('same-password'), await hashPassword('same-password'));
});

test('형식 검증: 정상 값 허용', () => {
  assert.equal(validateStudentNo('TEST-0001'), 'TEST-0001');
  assert.equal(validateUsername('test.admin'), 'test.admin');
  assert.equal(validateDisplayName(' 테스트학생1 '), '테스트학생1');
  assert.equal(validatePassword('abcdefgh'), 'abcdefgh');
});

test('형식 검증: SQL 주입 및 잘못된 값 거부', () => {
  for (const bad of ["x'; DROP TABLE students;--", '', 'a b', 'A'.repeat(33)]) {
    assert.throws(() => validateStudentNo(bad), UsageError);
  }
  for (const bad of ['ab', "admin'--", 'admin user']) assert.throws(() => validateUsername(bad), UsageError);
  for (const bad of ["홍길동'", '이름;', '', 'a'.repeat(41)]) assert.throws(() => validateDisplayName(bad), UsageError);
  for (const bad of ['short', 'a'.repeat(129), 'abc\ndefgh']) assert.throws(() => validatePassword(bad), UsageError);
});

test('sqlString 은 작은따옴표를 이중화한다', () => {
  assert.equal(sqlString("it's"), "'it''s'");
  assert.throws(() => sqlString('a\u0000b'), UsageError);
});

test('generatePassword 는 혼동 문자 없이 지정 길이로 생성한다', () => {
  const pw = generatePassword(16);
  assert.equal(pw.length, 16);
  assert.match(pw, /^[A-HJ-NP-Za-km-z2-9]+$/);
  assert.notEqual(generatePassword(), generatePassword());
});

test('SQL 빌더: 생성/재설정/비활성화 문장 구성', () => {
  const create = buildCreateStudentSql('TEST-0001', '테스트학생1', 'pbkdf2_sha256$1$a$b');
  assert.match(create, /INSERT INTO students/);
  assert.match(create, /account\.student_created/);

  const reset = buildResetPasswordSql('admin', 'testadmin', 'h');
  assert.match(reset, /UPDATE admins SET password_hash = 'h' WHERE username = 'testadmin' RETURNING id;/);
  assert.doesNotMatch(reset, /admins SET[^;]*updated_at/); // admins 테이블에는 updated_at 없음
  assert.match(reset, /UPDATE sessions SET revoked_at/);

  const deactivate = buildDeactivateSql('student', 'TEST-0001');
  assert.match(deactivate, /is_active = 0, updated_at/);
  assert.throws(() => buildDeactivateSql('teacher', 'x'), UsageError);
});

test('parseArgs: 옵션 처리', () => {
  assert.deepEqual(parseArgs(['list', '--remote']), { command: 'list', args: [], remote: true, yes: false, passwordStdin: false });
  assert.throws(() => parseArgs(['list', '--local', '--remote']), UsageError);
  assert.throws(() => parseArgs(['list', '--force']), UsageError);
});
