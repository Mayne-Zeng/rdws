import { useEffect, useRef, useState, type FormEvent } from 'react';
import { authClient } from '../lib/auth.ts';
import { Icon } from '../lib/ui.tsx';
import './login-screen.css';

export function LoginScreen({ checkingSession }: { checkingSession: boolean }) {
  const account = useRef<HTMLInputElement>(null);
  const password = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [visible, setVisible] = useState(false);
  const [missingAccount, setMissingAccount] = useState(false);
  const [missingPassword, setMissingPassword] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (error && !busy) password.current?.focus();
  }, [error, busy]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    const username = account.current?.value.trim() ?? '';
    const secret = password.current?.value ?? '';
    setError('');
    setMissingAccount(!username);
    setMissingPassword(!secret);
    if (!username || !secret) {
      (username ? password : account).current?.focus();
      return;
    }

    submitting.current = true;
    setVisible(false);
    setBusy(true);
    try {
      const result = await authClient.signIn.username({
        username,
        password: secret,
      });
      if (result.error) {
        const status = result.error.status;
        setError(
          status === 429
            ? '登录尝试过多，请稍后重试。'
            : status === 0 || status >= 500
              ? '暂时无法连接登录服务，请稍后重试。'
              : '登录失败，请检查账号与密码。',
        );
      } else if (password.current) password.current.value = '';
    } catch {
      setError('暂时无法连接登录服务，请稍后重试。');
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <header className="login-bar">
        <div className="login-identity">
          <span className="login-mark">
            <Icon name="branch" />
          </span>
          <div>
            <strong>rdws</strong>
            <span>产研一体化工作区</span>
          </div>
        </div>
      </header>
      <main className="login-main">
        {checkingSession ? (
          <p className="login-content login-intro" role="status">
            正在读取登录状态…
          </p>
        ) : (
          <section className="login-content" aria-labelledby="login-title">
            <h1 id="login-title">登录工作台</h1>
            <p className="login-intro">使用已分配的本地账号登录。</p>
            <form
              className="login-form"
              onSubmit={login}
              noValidate
              aria-busy={busy}
            >
              <div className="login-field">
                <label htmlFor="login-account">账号</label>
                <div className="login-control">
                  <Icon name="user" />
                  <input
                    ref={account}
                    id="login-account"
                    name="username"
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    placeholder="输入账号"
                    required
                    disabled={busy}
                    aria-invalid={missingAccount || undefined}
                    aria-describedby={
                      missingAccount ? 'login-account-error' : undefined
                    }
                    onChange={() => {
                      setMissingAccount(false);
                      setError('');
                    }}
                  />
                </div>
                {missingAccount && (
                  <p className="login-error" id="login-account-error">
                    请输入账号。
                  </p>
                )}
              </div>
              <div className="login-field">
                <label htmlFor="login-password">密码</label>
                <div className="login-control login-password">
                  <Icon name="lock" />
                  <input
                    ref={password}
                    id="login-password"
                    name="password"
                    type={visible ? 'text' : 'password'}
                    autoComplete="current-password"
                    placeholder="输入密码"
                    required
                    disabled={busy}
                    aria-invalid={missingPassword || undefined}
                    aria-describedby={
                      missingPassword ? 'login-password-error' : undefined
                    }
                    onChange={() => {
                      setMissingPassword(false);
                      setError('');
                    }}
                  />
                  <button
                    className="login-reveal"
                    type="button"
                    aria-label={visible ? '隐藏密码' : '显示密码'}
                    aria-controls="login-password"
                    disabled={busy}
                    onClick={() => setVisible(!visible)}
                  >
                    <Icon name={visible ? 'eyeOff' : 'eye'} />
                  </button>
                </div>
                {missingPassword && (
                  <p className="login-error" id="login-password-error">
                    请输入密码。
                  </p>
                )}
              </div>
              <button className="login-submit" type="submit" disabled={busy}>
                {busy ? '登录中…' : '登录'}
                {!busy && <Icon name="arrow" />}
              </button>
              {error && (
                <p className="login-error" role="alert">
                  {error}
                </p>
              )}
            </form>
            <span className="sr-only" role="status">
              {busy ? '登录中' : ''}
            </span>
          </section>
        )}
      </main>
      <footer className="login-bar login-status">
        <span>
          <Icon name="terminal" />
          本地环境
        </span>
        <span>
          <Icon name="shield" />
          预置账号 · 关闭注册
        </span>
      </footer>
    </div>
  );
}
