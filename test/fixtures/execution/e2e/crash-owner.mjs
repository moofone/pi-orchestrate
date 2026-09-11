import { digest } from "../../../../src/lib/execution-contract.ts";
import { createCoordinatorOwner, createExecutionStore } from "../../../../src/lib/execution-store.ts";

const [stateRoot, commonDir, sessionFile] = process.argv.slice(2);
const repo = { commonDir, id: digest(commonDir) };
const store = createExecutionStore({ stateRoot, repo });
const owner = store.acquire(createCoordinatorOwner(sessionFile, `e2e-crash-${process.pid}`));
store.markReconciled(owner);
process.stdout.write(`${process.pid}\n`);
setInterval(() => {}, 1_000);
