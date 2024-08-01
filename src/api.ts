import express from "express";

export default class LocalRestApiPublicApi {
  private router: express.Router;
  private onUnregister: () => void;
  private unregistered = false;

  constructor(router: express.Router, onUnregister: () => void) {
    this.router = router;
    this.onUnregister = onUnregister;
    this.unregistered = false;
  }

  /** Adds a route to the request handler. */
  public addRoute(path: string): express.IRoute {
    if (this.unregistered) {
      throw new Error(
        "Routes cannot be added after API extension has been unregistered."
      );
    }
    return this.router.route(path);
  }

  public unregister(): void {
    this.onUnregister();
    this.unregistered = true;
  }
}
