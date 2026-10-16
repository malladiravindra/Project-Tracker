import Dashboard from "@/components/Dashboard";
import LoginGate from "@/components/LoginGate";

export default function Home() {
  return (
    <LoginGate>
      <Dashboard />
    </LoginGate>
  );
}
