import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export function siblingSizes(root, pane) {
  if (root?.children?.some(child => child.id === pane)) {
    return root.children.map(child => {
      // Closing the placeholder can collapse a unary sibling wrapper. Its
      // surviving descendant is the stable resize target, at the same size.
      let target = child;
      while (target.children?.length === 1) target = target.children[0];
      return { id: target.id, ...(child.size?.px !== undefined
        ? { px: child.size.px } : { weight: child.size?.weight ?? 1 }) };
    });
  }
  for (const child of root?.children ?? []) {
    const sizes = siblingSizes(child, pane);
    if (sizes) return sizes;
  }
  return null;
}

async function sizesOf(tab, pane) {
  if (tab.includes("/")) throw new Error("Review replacement requires a local tab");
  const child = spawn("hc", ["connect"], { stdio: ["pipe", "pipe", "pipe"] });
  try {
    const result = await new Promise((resolve, reject) => {
      let output = "", errors = "";
      const timer = setTimeout(() => reject(new Error("Timed out reading the pane layout")), 5000);
      const fail = error => { clearTimeout(timer); reject(error); };
      child.on("error", fail);
      child.stdin.on("error", fail);
      child.stderr.on("data", chunk => { errors += chunk; });
      child.on("exit", () => fail(new Error(errors.trim() || "Layout connection closed")));
      child.stdout.on("data", chunk => {
        output += chunk;
        const lines = output.split("\n");
        output = lines.pop();
        for (const line of lines) {
          try {
            const reply = JSON.parse(line);
            if (reply.id !== 1) continue;
            clearTimeout(timer);
            if (reply.error) reject(new Error(reply.error.message));
            else resolve(reply.result);
          } catch (error) { fail(error); }
        }
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "doc.get", params: { name: "herdr-app" } }) + "\n");
    });
    const current = result.value?.spaces?.flatMap(space => space.tabs).find(item => item.id === tab);
    const sizes = siblingSizes(current?.root, pane);
    if (!sizes) throw new Error("The diff pane is no longer in its tab");
    return sizes;
  } finally { child.kill(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  sizesOf(process.argv[2], process.argv[3]).then(value => console.log(JSON.stringify(value)), error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
