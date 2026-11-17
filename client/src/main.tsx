import { render } from "preact";
import { AppRouter } from "./AppRouter";
import { Controller } from "./controller";

if (import.meta.env.DEV) {
  const screen = new URLSearchParams(location.search).get('dev-screen');
  if (screen) {
    const { DEV_SCREENS, devScreenURL } = await import('./dev-screens');
    if (DEV_SCREENS.find(fixture => fixture.id === screen)?.record)
      history.replaceState(null, '', devScreenURL(screen));
  }
}

function initializeController() {
  return (async () => {
    const controller = new Controller();
    await controller.initialize();
    window.downloadNetworkLog = () => controller.save("network-log");
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
    return controller;
  })();
}

render(
  <AppRouter initializeController={initializeController} />,
  document.getElementById("root")!,
);

declare global {
  interface Window {
    downloadNetworkLog: () => Promise<void>;
  }
}
