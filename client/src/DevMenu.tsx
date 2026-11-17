import type { Controller } from "./controller";
import { DEV_SCREEN_MENU, devScreenURL } from "./dev-screens.ts";

export default function DevMenu({ controller: c }: {
  controller?: Controller;
}) {
  return (
    <details id="dev-menu">
      <summary id="dev-menu-toggle">Dev menu</summary>
      {c && <section>
        <h2 id="network-log-title">Network log</h2>
        <button className="button" id="save-network-log" onClick={() => c.save("network-log")}>
          Save Network Log
        </button>
      </section>}
      <section id="dev-screen-tools">
        <ul>
          {DEV_SCREEN_MENU.map(screen => (
            <li key={screen.id}>
              <a
                href={devScreenURL(screen.id).href}
              >{screen.label}</a>
            </li>
          ))}
        </ul>
      </section>
    </details>
  );
}
