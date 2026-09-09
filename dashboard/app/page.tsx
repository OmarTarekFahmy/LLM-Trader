import Dashboard from "./Dashboard";
import { getAllStrategyData, getRegistry, getSharia, getUniverse } from "@/lib/state";

export const revalidate = 60;

export default async function Page() {
  const [registry, strategies, sharia, egx100] = await Promise.all([
    getRegistry(),
    getAllStrategyData(),
    getSharia(),
    getUniverse("egx100"),
  ]);
  return (
    <main>
      <Dashboard
        strategies={strategies}
        cadenceMinutes={registry.cadenceMinutes}
        sharia={sharia}
        universe={egx100}
      />
    </main>
  );
}
