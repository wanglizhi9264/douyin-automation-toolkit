import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
for (const file of ["test-focused-ui.mjs", "test-following-resume-ui.mjs"]) {
  console.log("UI regression:", file);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/" + file], {
      cwd: root,
      stdio: "inherit",
      detached: process.platform !== "win32",
    });
    const timer = setTimeout(() => {
      if (process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {}
      } else child.kill("SIGTERM");
      reject(new Error(file + " exceeded 30s"));
    }, 30000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(file + " exited " + code));
    });
  });
}
console.log("PASS modern UI workflows");
