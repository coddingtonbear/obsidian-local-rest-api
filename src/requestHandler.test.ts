import { App } from "obsidian";
import http from "http";
import request from "supertest";

import RequestHandler from "./requestHandler";
import { LocalRestApiSettings } from "./types";

const API_KEY = "my api key";

let settings: LocalRestApiSettings;
let app: App;
let handler: RequestHandler;
let server: http.Server;

beforeEach(() => {
  settings = getMockSettings();
  app = new App();
  handler = new RequestHandler(app, settings);
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

describe("requestHandler", () => {
  describe("requestIsAuthenticated", () => {
    test("missing header", () => {
      request(server).get("/vault/").expect(401);
    });
    test("incorrect header", () => {
      request(server)
        .get("/vault/")
        .set("Authorization", "Bearer of good tidings")
        .expect(401);
    });
    test("correct header", () => {
      request(server)
        .get("/vault/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);
    });
  });
});
