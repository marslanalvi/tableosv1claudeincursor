import {
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { SharePage } from "../routes/SharePage.tsx";
import shell from "./shell.module.css";

const rootRoute = createRootRoute({
  component: () => <Outlet />,
});

const shareRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/s/$token",
  component: function ShareRoute() {
    const { token } = shareRoute.useParams();
    return <SharePage token={token} />;
  },
});

const formRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/f/$token",
  component: function FormRoute() {
    const { token } = formRoute.useParams();
    return <SharePage token={token} />;
  },
});

function Landing() {
  return (
    <div className={shell.shell}>
      <div className={shell.landing}>
        <div>
          <h1>Tabula shared links</h1>
          <p>Open a shared view or form link to see its content here.</p>
        </div>
      </div>
    </div>
  );
}

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Landing,
});

const routeTree = rootRoute.addChildren([indexRoute, shareRoute, formRoute]);

export const router = createRouter({ routeTree, defaultNotFoundComponent: Landing });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
