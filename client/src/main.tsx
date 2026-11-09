import { render } from "preact";
import { App } from "./Application";
import { Controller } from "./controller";
const controller = new Controller();
await controller.initialize();

window.downloadNetworkLog = () => controller.save("network-log");
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") void controller.session.networkLog.flush();
});
render(
  <App controller={controller} />,
  document.getElementById("root")!,
);
if (import.meta.env.DEV) {
  const screen = new URLSearchParams(location.search).get("dev-screen");
  if (screen) {
    const { mountDevNavigation } = await import("./dev-screens.ts");

    const mount = () =>
      document.getElementById("connection-menu")
        ? mountDevNavigation(screen)
        : requestAnimationFrame(mount);
    requestAnimationFrame(mount);
  }
}

declare global {
  interface Window {
    downloadNetworkLog: () => Promise<void>;
  }
}
