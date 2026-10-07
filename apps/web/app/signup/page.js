import AuthForm from '../../components/AuthForm';

export const metadata = { title: 'Create an account | CloudStore' };

export default function SignupPage() {
  return <AuthForm mode="signup" />;
}
