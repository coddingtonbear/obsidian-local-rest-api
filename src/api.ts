import express from "express";
import { BUILT_IN_ROUTES } from "./constants";

export interface RegisteredRoute {
  path: string;
  authenticated: boolean;
}

export default class LocalRestApiPublicApi {
  private router: express.Router;
  private publicRouter: express.Router;
  private onUnregister: () => void;
  private unregistered = false;
  private registeredRoutes: RegisteredRoute[] = [];

  constructor(router: express.Router, publicRouter: express.Router, onUnregister: () => void) {
    this.router = router;
    this.publicRouter = publicRouter;
    this.onUnregister = onUnregister;
    this.unregistered = false;
  }

  private assertRegistered(): void {
    if (this.unregistered) {
      throw new Error(
        "Routes cannot be added after API extension has been unregistered."
      );
    }
  }

  public getRoutes(): RegisteredRoute[] {
    return this.registeredRoutes;
  }

  /** Adds an authenticated route to the request handler. */
  public addRoute(path: string): express.IRoute {
    this.assertRegistered();
    this.registeredRoutes.push({ path, authenticated: true });
    return this.router.route(path);
  }

  /** Adds an unauthenticated route to the request handler. */
  public addPublicRoute(path: string): express.IRoute {
    this.assertRegistered();
    if (BUILT_IN_ROUTES.includes(path)) {
      throw new Error(
        `Cannot register a public route at "${path}" — this path is reserved by Obsidian Local REST API.`
      );
    }
    this.registeredRoutes.push({ path, authenticated: false });
    return this.publicRouter.route(path);
  }

  public unregister(): void {
    this.onUnregister();
    this.unregistered = true;
  }
}
