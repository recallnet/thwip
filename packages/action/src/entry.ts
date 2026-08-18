import { runAction } from "./main.js";

runAction()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    console.error(`thwip: FAIL — ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
