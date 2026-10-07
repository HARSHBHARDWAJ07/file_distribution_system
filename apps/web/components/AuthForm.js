'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import Wordmark from './Wordmark';
import ErrorNote from './ErrorNote';
import { getApi } from '../lib/client.js';

const COPY = {
  login: {
    title: 'Sign in',
    lede: 'Your files are waiting where you left them.',
    action: 'Sign in',
    busy: 'Signing in',
    switchText: 'New here?',
    switchLink: { href: '/signup', label: 'Create an account' },
  },
  signup: {
    title: 'Create an account',
    lede: 'Keep your files in one place. Large ones upload in parts, so a dropped connection only costs one part.',
    action: 'Create account',
    busy: 'Creating your account',
    switchText: 'Already have an account?',
    switchLink: { href: '/login', label: 'Sign in' },
  },
};

export default function AuthForm({ mode }) {
  const copy = COPY[mode];
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    setExpired(new URLSearchParams(window.location.search).has('expired'));
  }, []);

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const api = getApi();
    try {
      if (mode === 'signup') await api.signup(email, password);
      await api.login(email, password);
      router.replace('/files');
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <Wordmark href="/" />
      <h1>{copy.title}</h1>
      <p className="auth-lede">{copy.lede}</p>
      {expired && !error && (
        <div className="notice notice-info" role="status"><p>Your session ended. Sign in again to continue.</p></div>
      )}
      <form onSubmit={submit} noValidate={false}>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" type="email" autoComplete="email" required value={email}
            onChange={e => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" type="password" required minLength={mode === 'signup' ? 8 : 1}
            autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            value={password} onChange={e => setPassword(e.target.value)}
            aria-describedby={mode === 'signup' ? 'password-hint' : undefined} />
          {mode === 'signup' && <p className="field-hint" id="password-hint">At least 8 characters.</p>}
        </div>
        {error && <ErrorNote error={error} />}
        <button type="submit" className="button button-primary" disabled={busy}>
          {busy ? copy.busy : copy.action}
        </button>
      </form>
      <p className="auth-switch">
        {copy.switchText} <Link href={copy.switchLink.href}>{copy.switchLink.label}</Link>
      </p>
    </main>
  );
}
