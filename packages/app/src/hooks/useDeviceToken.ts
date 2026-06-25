import { useState, useCallback } from 'react';

const DEVICE_TOKEN_KEY = 'kp_device';

function generateToken(): string {
  // 16 random bytes as hex — same approach as the original JS client
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function useDeviceToken(): string {
  const [token] = useState<string>(() => {
    const stored = localStorage.getItem(DEVICE_TOKEN_KEY);
    if (stored) return stored;
    const newToken = generateToken();
    localStorage.setItem(DEVICE_TOKEN_KEY, newToken);
    return newToken;
  });
  return token;
}

export function clearDeviceToken(): void {
  localStorage.removeItem(DEVICE_TOKEN_KEY);
}

export function useResetDeviceToken(): () => string {
  return useCallback(() => {
    const newToken = generateToken();
    localStorage.setItem(DEVICE_TOKEN_KEY, newToken);
    return newToken;
  }, []);
}
