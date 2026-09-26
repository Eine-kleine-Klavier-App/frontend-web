import { useState } from 'react';
import { GoogleAlreadyLinkedError, linkGoogle, setPassword } from '@/core/auth/accountApi';
import { PASSWORD_MIN_LENGTH } from '@/core/auth/authApi';
import { errorMessage } from '@/core/errorMessage';
import { Button } from '@/ui/Button';
import { GoogleSignInButton } from './GoogleSignInButton';

type Notice = { tone: 'ok' | 'error'; text: string };

/** The signed-in user's sign-in methods, on the You screen: set or change the password, and link a
 *  Google account to this same account. Both work for any account whichever way it was created —
 *  there is no per-method state to show, only the result of the last action. */
export function AccountSecurity() {
  const [password, setPasswordValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [passwordNotice, setPasswordNotice] = useState<Notice | null>(null);
  const [googleNotice, setGoogleNotice] = useState<Notice | null>(null);

  const savePassword = async () => {
    if (busy || password.length < PASSWORD_MIN_LENGTH) return;
    setBusy(true);
    setPasswordNotice(null);
    try {
      await setPassword(password);
      setPasswordValue('');
      setPasswordNotice({ tone: 'ok', text: 'Password saved. Your other devices were signed out.' });
    } catch (e) {
      setPasswordNotice({ tone: 'error', text: errorMessage(e, 'Could not save the password.') });
    }
    setBusy(false);
  };

  const link = async (idToken: string) => {
    setGoogleNotice(null);
    try {
      await linkGoogle(idToken);
      setGoogleNotice({ tone: 'ok', text: 'Google account linked — you can now sign in with it.' });
    } catch (e) {
      setGoogleNotice({
        tone: 'error',
        text: e instanceof GoogleAlreadyLinkedError ? e.message : errorMessage(e, 'Could not link Google.'),
      });
    }
  };

  return (
    <section className="you-security" aria-labelledby="you-security-title">
      <h2 id="you-security-title" className="you-security-title">Sign-in methods</h2>

      <form
        className="you-security-row"
        onSubmit={(e) => {
          e.preventDefault();
          void savePassword();
        }}
      >
        <label className="auth-field-label" htmlFor="you-password">Password</label>
        <div className="you-security-control">
          <input
            id="you-password"
            className="auth-field"
            type="password"
            value={password}
            onChange={(e) => setPasswordValue(e.target.value)}
            placeholder={`New password, at least ${PASSWORD_MIN_LENGTH} characters`}
            maxLength={128}
            autoComplete="new-password"
            disabled={busy}
          />
          <Button variant="secondary" type="submit" disabled={busy || password.length < PASSWORD_MIN_LENGTH}>
            Save password
          </Button>
        </div>
        <p className={'you-security-notice' + (passwordNotice ? ` you-security-notice--${passwordNotice.tone}` : '')} role="status">
          {passwordNotice?.text ?? '\u00a0'}
        </p>
      </form>

      <div className="you-security-row">
        <span className="auth-field-label">Google</span>
        <div className="you-security-control">
          <GoogleSignInButton onCredential={(token) => void link(token)} onError={(text) => setGoogleNotice({ tone: 'error', text })} />
        </div>
        <p className={'you-security-notice' + (googleNotice ? ` you-security-notice--${googleNotice.tone}` : '')} role="status">
          {googleNotice?.text ?? '\u00a0'}
        </p>
      </div>
    </section>
  );
}
