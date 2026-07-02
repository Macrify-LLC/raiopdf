type RegionProps = {
  label: string;
};

function Region({ label }: RegionProps) {
  return <section>{label}</section>;
}

export function AppShell() {
  return (
    <main className="app-shell">
      <header className="app-shell__command-bar">Top command bar</header>
      <aside className="app-shell__thumbnail-rail">
        <Region label="Left thumbnail rail" />
      </aside>
      <section className="app-shell__canvas">
        <Region label="Center canvas" />
      </section>
      <aside className="app-shell__tool-panel">
        <Region label="Right tool panel" />
      </aside>
    </main>
  );
}
