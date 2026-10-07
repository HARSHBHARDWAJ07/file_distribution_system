'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getApi } from '../lib/client.js';

// No content of its own: send people to their files or to sign in.
export default function Home() {
  const router = useRouter();
  useEffect(() => {
    router.replace(getApi().isSignedIn() ? '/files' : '/login');
  }, [router]);
  return null;
}
