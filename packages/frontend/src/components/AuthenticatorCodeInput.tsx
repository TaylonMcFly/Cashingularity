import React, { forwardRef } from 'react';

export const normalizeAuthenticatorCode = (value: string) => value.replace(/[^0-9]/g, '').slice(0, 6);
export const isAuthenticatorCode = (value: string) => /^[0-9]{6}$/.test(value);

export const AuthenticatorCodeInput = forwardRef<HTMLInputElement, {
  label: string;
  value: string;
  onChange: (code: string) => void;
}>(function AuthenticatorCodeInput({ label, value, onChange }, ref) {
  return <input ref={ref} type="text" className="input-field totp-code" aria-label={label}
    inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" value={value} required
    onChange={event => onChange(normalizeAuthenticatorCode(event.currentTarget.value))}
    onPaste={event => {
      event.preventDefault();
      const text = event.clipboardData.getData('text');
      const { selectionStart, selectionEnd } = event.currentTarget;
      onChange(normalizeAuthenticatorCode(value.slice(0, selectionStart ?? 0) + text + value.slice(selectionEnd ?? value.length)));
    }} />;
});
