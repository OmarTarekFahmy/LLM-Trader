import Dashboard from "./Dashboard";
import { getAllStrategyData, getRegistry } from "@/lib/state";

export const revalidate = 60;

export default async function Page() {
  const [registry, strategies] = await Promise.all([getRegistry(), getAllStrategyData()]);
  return (
    <main>
      <Dashboard strategies={strategies} cadenceMinutes={registry.cadenceMinutes} />
    </main>
  );
}
