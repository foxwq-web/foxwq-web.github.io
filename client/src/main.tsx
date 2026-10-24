import { createRoot } from "react-dom/client";
import { App } from "./Application";
import { Controller } from "./controller";
const controller = new Controller();
await controller.initialize();

window.downloadNetworkLog = () => controller.save("network-log");
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") void controller.session.networkLog.flush();
});
createRoot(document.getElementById("root")!).render(
  <App controller={controller} />,
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
