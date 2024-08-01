import express from "express";

export default class LocalRestApiPublicApi {
  private router: express.Router;
  private unregisterHandler: () => void;

  constructor(router: express.Router, unregister: () => void) {
    this.router = router;
    this.unregisterHandler = unregister;
  }

  /** Adds a route to the request handler. */
  public addRoute(path: string): express.IRoute {
    return this.router.route(path);
  }

  public unregister(): void {
    this.unregisterHandler();
  }
}
