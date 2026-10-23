import type { Controller } from "./controller";
import { DEV_SCREENS } from "./dev-screens.ts";

export default function DevMenu({ controller: c }: {
  controller: Controller;
}) {
  const screenURL = (id: string) => {
    const url = new URL(location.href);
    url.searchParams.set("dev-screen", id);
    return url.href;
  };
  return (
    <details id="dev-menu">
      <summary id="dev-menu-toggle">Dev menu</summary>
      <section>
        <h2 id="network-log-title">Network log</h2>
        <button id="save-network-log" onClick={() => c.save("network-log")}>
          Save Network Log
        </button>
      </section>
      <section id="dev-screen-tools">
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
