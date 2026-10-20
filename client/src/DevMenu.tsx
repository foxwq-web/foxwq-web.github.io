import { DEV_SCREENS } from "./dev-screens.ts";

export default function DevMenu() {
  const screenURL = (id: string | null) => {
    const url = new URL(location.href);
    if (id) url.searchParams.set("dev-screen", id);
    else url.searchParams.delete("dev-screen");
    return url.href;
  };
  return (
    <details id="dev-menu">
      <summary id="dev-menu-toggle">Dev menu</summary>
      <section id="dev-screen-tools">
        <h2>Dev screens</h2>
        <p><a href={screenURL("all")}>All screen previews</a></p>
        <p><a href={screenURL(null)}>Return to app</a></p>
        {Array.from(new Set(DEV_SCREENS.map(screen => screen.group))).map(group => (
          <section key={group}>
            <h3>{group}</h3>
            <ul>
              {DEV_SCREENS.filter(screen => screen.group === group).map(screen => (
                <li key={screen.id}>
                  <a
                    href={screenURL(screen.id)}
                    title={screen.reach}
                  >{screen.label}</a>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </section>
    </details>
  );
}
