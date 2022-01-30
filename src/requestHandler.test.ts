import { App } from "obsidian";
import http from "http";
import request from "supertest";

import RequestHandler from "./requestHandler";
import { LocalRestApiSettings } from "./types";
import { CERT_NAME } from "./constants";

describe("requestHandler", () => {
  const API_KEY = "my api key";

  let settings: LocalRestApiSettings;
  let app: App;
  let handler: RequestHandler;
  let server: http.Server;

  beforeEach(() => {
    settings = getMockSettings();
    app = new App();
    handler = new RequestHandler(app, settings);
    handler.setupRouter();
    server = http.createServer(handler.api);
  });

  afterEach(() => {
    server.close();
  });

  function getMockSettings(): LocalRestApiSettings {
    return {
      apiKey: API_KEY,
      crypto: {
        cert: "cert",
        privateKey: "privateKey",
        publicKey: "publicKey",
      },
      port: 1,
    };
  }
  describe("requestIsAuthenticated", () => {
    const arbitraryAuthenticatedRoute = "/vault/";

    test("missing header", async () => {
      await request(server).get(arbitraryAuthenticatedRoute).expect(401);
    });
    test("incorrect header", async () => {
      await request(server)
        .get(arbitraryAuthenticatedRoute)
        .set("Authorization", "Bearer of good tidings")
        .expect(401);
    });
    test("correct header", async () => {
      await request(server)
        .get(arbitraryAuthenticatedRoute)
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);
    });
  });

  describe("root", () => {
    test("withhout auth", async () => {
      const result = await request(server).get("/").expect(200);

      expect(result.body.status).toEqual("OK");
      expect(result.body.authenticated).toBeFalsy();
    });

    test("with auth", async () => {
      const result = await request(server)
        .get("/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);

      expect(result.body.status).toEqual("OK");
      expect(result.body.authenticated).toBeTruthy();
    });
  });

  describe("certificateGet", () => {
    const certPath = `/${CERT_NAME}`;

    test("withhout auth", async () => {
      const result = await request(server).get(certPath).expect(200);

      expect(result.body.toString()).toEqual(settings.crypto.cert);
    });

    test("with auth", async () => {
      const result = await request(server)
        .get(certPath)
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);

      expect(result.body.toString()).toEqual(settings.crypto.cert);
    });
  });
});
