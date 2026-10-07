import AuthForm from '../../components/AuthForm';

export const metadata = { title: 'Sign in | CloudStore' };

export default function LoginPage() {
  return <AuthForm mode="login" />;
}
