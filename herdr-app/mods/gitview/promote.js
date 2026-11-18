// Keep the original review until the destination has rendered the selected
// file. Only a tab created by this operation may be removed on failure.
export async function promoteReview({ space, sourceTab, view, scope }, host) {
  const made = await host.command("tab.new", { name: "gitview", space, mod: "gitview-diff", props: { space, own: true } });
  if (!made?.tab) throw new Error(made?.error ?? "The review tab did not open");
  const tab = made.tab;
  let ready = false;
  try {
    host.prepare(tab, view);
    await host.sidebar(["sidebar", "--tab", tab, "--mod", "gitview", "--percent", "29", "--props",
      JSON.stringify({ cwd: view.root, on: view.on ?? null, space, tab, own: true, scope })]);
    await host.waitReady(tab);
    ready = true;
    await host.closeSource(sourceTab);
    return tab;
  } catch (error) {
    if (!ready) {
      await host.command("tab.close", { id: tab, confirmed: true });
      await host.cancel(tab);
      await host.command("tab.select", { id: sourceTab });
    }
    throw error;
  }
}
