/**
 * 로그인 폼 (학생/관리자 공용 UI, 호출 측에서 서로 다른 API를 연결)
 * onSubmit({ id, password }) 가 예외를 던지면 오류 메시지를 표시한다.
 */
export function createLoginForm({ title, idLabel, idName, idAutocomplete = 'username', onSubmit }) {
  const form = document.createElement('form');
  form.className = 'login-form';
  form.noValidate = true;

  const heading = document.createElement('h2');
  heading.textContent = title;

  const idField = field(idLabel, idName, 'text', idAutocomplete);
  const pwField = field('비밀번호', 'password', 'password', 'current-password');

  const error = document.createElement('p');
  error.className = 'form-error';
  error.setAttribute('role', 'alert');

  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'btn btn-primary';
  submit.textContent = '로그인';

  form.append(heading, idField.wrapper, pwField.wrapper, error, submit);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const id = idField.input.value.trim();
    const password = pwField.input.value;
    if (!id || !password) {
      error.textContent = `${idLabel}와(과) 비밀번호를 입력하세요.`;
      return;
    }
    submit.disabled = true;
    error.textContent = '';
    try {
      await onSubmit({ id, password });
      idField.input.value = '';
    } catch (err) {
      error.textContent = err?.message || '로그인에 실패했습니다.';
    } finally {
      pwField.input.value = '';
      submit.disabled = false;
    }
  });

  return {
    element: form,
    focus: () => idField.input.focus(),
    /** 테스트 계정 안내 등에서 값을 채워 넣는다 (제출은 사용자가 직접) */
    fill: (id, password) => {
      idField.input.value = id;
      pwField.input.value = password;
      error.textContent = '';
      submit.focus();
    },
    reset: () => { form.reset(); error.textContent = ''; },
  };
}

function field(labelText, name, type, autocomplete) {
  const wrapper = document.createElement('label');
  wrapper.className = 'form-field';
  const span = document.createElement('span');
  span.textContent = labelText;
  const input = document.createElement('input');
  input.name = name;
  input.type = type;
  input.autocomplete = autocomplete;
  input.maxLength = type === 'password' ? 128 : 32;
  input.required = true;
  wrapper.append(span, input);
  return { wrapper, input };
}
