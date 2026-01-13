import http from "http";
import request from "supertest";

import RequestHandler from "./requestHandler";
import { LocalRestApiSettings } from "./types";
import { CERT_NAME } from "./constants";
import {
  App,
  TFile,
  Command,
  HeadingCache,
  PluginManifest,
  _prepareSimpleSearchMock,
  SearchResult,
} from "../mocks/obsidian";

describe("requestHandler", () => {
  const API_KEY = "my api key";

  let settings: LocalRestApiSettings;
  let app: App;
  let manifest: PluginManifest;
  let handler: RequestHandler;
  let server: http.Server;

  beforeEach(() => {
    settings = getMockSettings();
    // This 'App' instance is actually a mock, and it doesn't define
    // quite a perfectly-matching interface for the actual Obsidian
    // App interface.
    app = new App();
    manifest = new PluginManifest();
    // @ts-ignore: Ignore missing App properties
    handler = new RequestHandler(app, manifest, settings);
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
      insecurePort: 2,
      enableInsecureServer: false,
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

      expect(result.body.toString()).toEqual(settings.crypto?.cert);
    });

    test("with auth", async () => {
      const result = await request(server)
        .get(certPath)
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);

      expect(result.body.toString()).toEqual(settings.crypto.cert);
    });
  });

  describe("vaultGet", () => {
    test("directory empty", async () => {
      app.vault._files = [];

      await request(server)
        .get("/vault/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(404);
    });

    test("directory with files", async () => {
      const arbitraryDirectory = "somewhere";

      const rootFile = new TFile();
      rootFile.path = "rootFile.md";

      const notRootFile = new TFile();
      notRootFile.path = `${arbitraryDirectory}/anotherFile.md`;

      app.vault._files = [rootFile, notRootFile];

      const result = await request(server)
        .get("/vault/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);

      expect(result.body.files).toEqual([
        rootFile.path,
        `${arbitraryDirectory}/`,
      ]);
    });

    test("unauthorized", async () => {
      const arbitraryFilename = "somefile.md";
      const arbitraryFileContent = "Beep boop";

      app.vault.adapter._read = arbitraryFileContent;

      await request(server).get(`/vault/${arbitraryFilename}`).expect(401);
    });

    test("file content", async () => {
      const arbitraryFilename = "somefile.md";
      const arbitraryFileContent = "Beep boop";
      const fileContentBuffer = new ArrayBuffer(arbitraryFileContent.length);
      const fileContentBufferView = new Uint8Array(fileContentBuffer);
      for (let i = 0; i < arbitraryFileContent.length; i++) {
        fileContentBufferView[i] = arbitraryFileContent.charCodeAt(i);
      }

      app.vault.adapter._readBinary = fileContentBuffer;

      const result = await request(server)
        .get(`/vault/${arbitraryFilename}`)
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);

      expect(result.header["content-disposition"]).toEqual(
        `attachment; filename="${arbitraryFilename}"`
      );
      expect(result.header["content-type"]).toEqual(
        "text/markdown; charset=utf-8"
      );
      expect(result.text).toEqual(arbitraryFileContent);
    });

    test("file does not exist", async () => {
      const arbitraryFilename = "somefile.md";

      app.vault.adapter._exists = false;

      await request(server)
        .get(`/vault/${arbitraryFilename}`)
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(404);
    });
  });

  describe("vaultPut", () => {
    test("directory", async () => {
      await request(server)
        .put("/vault/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(405);
    });

    test("unauthorized", async () => {
      const arbitraryFilePath = "somefile.md";
      const arbitraryBytes = "bytes";

      await request(server)
        .put(`/vault/${arbitraryFilePath}`)
        .set("Content-Type", "text/markdown")
        .send(arbitraryBytes)
        .expect(401);
    });

    test("acceptable content", async () => {
      const arbitraryFilePath = "somefile.md";
      const arbitraryBytes = "bytes";

      await request(server)
        .put(`/vault/${arbitraryFilePath}`)
        .set("Content-Type", "text/markdown")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send(arbitraryBytes)
        .expect(204);

      expect(app.vault.adapter._write).toEqual([
        arbitraryFilePath,
        arbitraryBytes,
      ]);
    });

    test("acceptable binary content", async () => {
      const arbitraryFilePath = "test.png";
      const arbitraryBytes = "bytes"; // mock a picture binary

      await request(server)
        .put(`/vault/${arbitraryFilePath}`)
        .set("Content-Type", "image/jpeg")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send(arbitraryBytes)
        .expect(204);

      expect(app.vault.adapter._writeBinary[0]).toEqual(arbitraryFilePath);
      const data = app.vault.adapter._writeBinary[1];
      expect(Buffer.isBuffer(data) || data instanceof ArrayBuffer).toEqual(
        true
      );
      // We won't be able to convert the incoming data
      // to bytes with this mechanism in a _normal_
      // situation because those bytes won't be encodable
      // as ASCII, but we can do this here because we're
      // lying about the incoming content type above
      const decoder = new TextDecoder();
      expect(decoder.decode(data)).toEqual(arbitraryBytes);
    });

    test("non-bytes content", async () => {
      const arbitraryFilePath = "somefile.md";
      const arbitraryBytes = "bytes";

      await request(server)
        .put(`/vault/${arbitraryFilePath}`)
        .set("Content-Type", "application/json")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send(arbitraryBytes)
        .expect(400);

      expect(app.vault.adapter._write).toBeUndefined();
    });
  });

  describe("vaultPost", () => {
    test("directory", async () => {
      await request(server)
        .post("/vault/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(405);
    });

    test("unauthorized", async () => {
      const arbitraryFilePath = "somefile.md";
      const arbitraryBytes = "bytes";

      const arbitraryExistingBytes = "something\nsomething\n";

      app.vault._read = arbitraryExistingBytes;

      await request(server)
        .post(`/vault/${arbitraryFilePath}`)
        .set("Content-Type", "text/markdown")
        .send(arbitraryBytes)
        .expect(401);
    });

    describe("acceptable content", () => {
      test("existing with trailing newline", async () => {
        const arbitraryFilePath = "somefile.md";
        const arbitraryBytes = "bytes";

        const arbitraryExistingBytes = "something\nsomething\n";

        app.vault._read = arbitraryExistingBytes;

        await request(server)
          .post(`/vault/${arbitraryFilePath}`)
          .set("Content-Type", "text/markdown")
          .set("Authorization", `Bearer ${API_KEY}`)
          .send(arbitraryBytes)
          .expect(204);

        expect(app.vault.adapter._write).toEqual([
          arbitraryFilePath,
          arbitraryExistingBytes + arbitraryBytes,
        ]);
      });

      test("existing without trailing newline", async () => {
        const arbitraryFilePath = "somefile.md";
        const arbitraryBytes = "bytes";

        const arbitraryExistingBytes = "something\nsomething";

        app.vault._read = arbitraryExistingBytes;

        await request(server)
          .post(`/vault/${arbitraryFilePath}`)
          .set("Content-Type", "text/markdown")
          .set("Authorization", `Bearer ${API_KEY}`)
          .send(arbitraryBytes)
          .expect(204);

        expect(app.vault.adapter._write).toEqual([
          arbitraryFilePath,
          arbitraryExistingBytes + "\n" + arbitraryBytes,
        ]);
      });
    });

    test("non-bytes content", async () => {
      const arbitraryFilePath = "somefile.md";
      const arbitraryBytes = "bytes";

      await request(server)
        .post(`/vault/${arbitraryFilePath}`)
        .set("Content-Type", "application/json")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send(arbitraryBytes)
        .expect(400);

      expect(app.vault.adapter._write).toBeUndefined();
    });
  });

  describe("vaultDelete", () => {
    test("directory", async () => {
      await request(server)
        .delete("/vault/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(405);
    });

    test("non-existing file", async () => {
      const arbitraryFilePath = "somefile.md";
      const arbitraryBytes = "bytes";

      app.vault.adapter._exists = false;

      await request(server)
        .delete(`/vault/${arbitraryFilePath}`)
        .set("Content-Type", "text/markdown")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send(arbitraryBytes)
        .expect(404);

      expect(app.vault.adapter._remove).toBeUndefined();
    });

    test("unauthorized", async () => {
      const arbitraryFilePath = "somefile.md";
      const arbitraryBytes = "bytes";

      await request(server)
        .delete(`/vault/${arbitraryFilePath}`)
        .set("Content-Type", "text/markdown")
        .send(arbitraryBytes)
        .expect(401);
    });

    test("existing file", async () => {
      const arbitraryFilePath = "somefile.md";
      const arbitraryBytes = "bytes";

      await request(server)
        .delete(`/vault/${arbitraryFilePath}`)
        .set("Content-Type", "text/markdown")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send(arbitraryBytes)
        .expect(204);

      expect(app.vault.adapter._remove).toEqual([arbitraryFilePath]);
    });
  });

  describe("vaultPatch", () => {
    test("directory", async () => {
      await request(server)
        .patch("/vault/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(405);
    });

    test("missing heading header", async () => {
      const arbitraryFilePath = "somefile.md";
      const arbitraryBytes = "bytes";
      const arbitraryHeading = "somewhere";

      const arbitraryExistingBytes = "something\nsomething";

      const headingCache = new HeadingCache();
      headingCache.heading = arbitraryHeading;

      app.vault._read = arbitraryExistingBytes;
      app.metadataCache._getFileCache.headings.push(headingCache);

      await request(server)
        .patch(`/vault/${arbitraryFilePath}`)
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Content-Type", "text/markdown")
        .send(arbitraryBytes)
        .expect(400);
    });

    test("non-bytes content", async () => {
      const arbitraryFilePath = "somefile.md";
      const arbitraryBytes = "bytes";
      const arbitraryHeading = "somewhere";

      const arbitraryExistingBytes = "something\nsomething";

      const headingCache = new HeadingCache();
      headingCache.heading = arbitraryHeading;

      app.vault._read = arbitraryExistingBytes;
      app.metadataCache._getFileCache.headings.push(headingCache);

      await request(server)
        .patch(`/vault/${arbitraryFilePath}`)
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Heading", arbitraryHeading)
        .send(arbitraryBytes)
        .expect(400);
    });

    test("non-existing file", async () => {
      const arbitraryFilePath = "somefile.md";
      const arbitraryBytes = "bytes";
      const arbitraryHeading = "somewhere";

      const arbitraryExistingBytes = "something\nsomething";

      const headingCache = new HeadingCache();
      headingCache.heading = arbitraryHeading;

      app.vault._read = arbitraryExistingBytes;
      app.metadataCache._getFileCache.headings.push(headingCache);
      app.vault._getAbstractFileByPath = null;

      await request(server)
        .patch(`/vault/${arbitraryFilePath}`)
        .set("Authorization", `Bearer ${API_KEY}`)
        .set("Content-Type", "text/markdown")
        .set("Heading", arbitraryHeading)
        .send(arbitraryBytes)
        .expect(404);
    });

    test("unauthorized", async () => {
      const arbitraryFilePath = "somefile.md";
      const arbitraryBytes = "bytes";
      const arbitraryHeading = "somewhere";

      const arbitraryExistingBytes = "something\nsomething";

      const headingCache = new HeadingCache();
      headingCache.heading = arbitraryHeading;

      app.vault._read = arbitraryExistingBytes;
      app.metadataCache._getFileCache.headings.push(headingCache);

      await request(server)
        .patch(`/vault/${arbitraryFilePath}`)
        .set("Content-Type", "text/markdown")
        .set("Heading", arbitraryHeading)
        .set("Content-Insertion-Position", "beginning")
        .send(arbitraryBytes)
        .expect(401);
    });

    describe("acceptable content", () => {
      // Unfortunately, testing the actual written content would be
      // extremely brittle given that we're relying on private Obsidian
      // API interfaces; so we're just going to verify that we get
      // a 200 and that a write occurs :shrug:

      test("undefined content-insertion-position", async () => {
        const arbitraryFilePath = "somefile.md";
        const arbitraryBytes = "bytes";
        const arbitraryHeading = "somewhere";

        const arbitraryExistingBytes = "something\nsomething";

        const headingCache = new HeadingCache();
        headingCache.heading = arbitraryHeading;

        app.vault._read = arbitraryExistingBytes;
        app.metadataCache._getFileCache.headings.push(headingCache);

        const result = await request(server)
          .patch(`/vault/${arbitraryFilePath}`)
          .set("Authorization", `Bearer ${API_KEY}`)
          .set("Content-Type", "text/markdown")
          .set("Heading", arbitraryHeading)
          .send(arbitraryBytes)
          .expect(200);

        expect(app.vault.adapter.write).toBeTruthy();
        expect(result.text).toBeTruthy();
      });

      test("beginning content-insertion-position", async () => {
        const arbitraryFilePath = "somefile.md";
        const arbitraryBytes = "bytes";
        const arbitraryHeading = "somewhere";

        const arbitraryExistingBytes = "something\nsomething";

        const headingCache = new HeadingCache();
        headingCache.heading = arbitraryHeading;

        app.vault._read = arbitraryExistingBytes;
        app.metadataCache._getFileCache.headings.push(headingCache);

        const result = await request(server)
          .patch(`/vault/${arbitraryFilePath}`)
          .set("Authorization", `Bearer ${API_KEY}`)
          .set("Content-Type", "text/markdown")
          .set("Heading", arbitraryHeading)
          .set("Content-Insertion-Position", "beginning")
          .send(arbitraryBytes)
          .expect(200);

        expect(app.vault.adapter.write).toBeTruthy();
        expect(result.text).toBeTruthy();
        expect(result.text).toEqual("bytes\nsomething\nsomething");
      });

      test("end content-insertion-position", async () => {
        const arbitraryFilePath = "somefile.md";
        const arbitraryBytes = "bytes";
        const arbitraryHeading = "somewhere";

        const arbitraryExistingBytes = "something\nsomething";

        const headingCache = new HeadingCache();
        headingCache.heading = arbitraryHeading;

        app.vault._read = arbitraryExistingBytes;
        app.metadataCache._getFileCache.headings.push(headingCache);

        const result = await request(server)
          .patch(`/vault/${arbitraryFilePath}`)
          .set("Authorization", `Bearer ${API_KEY}`)
          .set("Content-Type", "text/markdown")
          .set("Heading", arbitraryHeading)
          .set("Content-Insertion-Position", "end")
          .send(arbitraryBytes)
          .expect(200);

        expect(app.vault.adapter.write).toBeTruthy();
        expect(result.text).toBeTruthy();
        expect(result.text).toEqual("something\nsomething\nbytes");
      });

      test("beginning content-insertion-position with header", async () => {
        const arbitraryFilePath = "somefile.md";
        const arbitraryBytes = "bytes";
        const arbitraryHeading = "Heading1";

        const arbitraryExistingBytes =
          "something\n\n# Heading1\ncontent here\n# Heading2\nsomething";
        app.vault._read = arbitraryExistingBytes;

        // Heading 1
        let headingCache = new HeadingCache();
        headingCache.heading = arbitraryHeading;

        headingCache.position.end.line = 2;
        headingCache.position.start.line = 2;
        app.metadataCache._getFileCache.headings.push(headingCache);

        // Heading 2
        headingCache = new HeadingCache();
        headingCache.heading = "Heading2";

        headingCache.position.end.line = 4;
        headingCache.position.start.line = 4;
        app.metadataCache._getFileCache.headings.push(headingCache);

        const result = await request(server)
          .patch(`/vault/${arbitraryFilePath}`)
          .set("Authorization", `Bearer ${API_KEY}`)
          .set("Content-Type", "text/markdown")
          .set("Heading", arbitraryHeading)
          .set("Content-Insertion-Position", "beginning")
          .send(arbitraryBytes)
          .expect(200);

        expect(app.vault.adapter.write).toBeTruthy();
        expect(result.text).toBeTruthy();
        expect(result.text).toEqual(
          "something\n\n# Heading1\nbytes\ncontent here\n# Heading2\nsomething"
        );
      });

      test("end content-insertion-position with header", async () => {
        const arbitraryFilePath = "somefile.md";
        const arbitraryBytes = "bytes";
        const arbitraryHeading = "Heading1";

        const arbitraryExistingBytes =
          "something\n\n# Heading1\ncontent here\n# Heading2\nsomething";
        app.vault._read = arbitraryExistingBytes;

        // Heading 1
        let headingCache = new HeadingCache();
        headingCache.heading = arbitraryHeading;

        headingCache.position.end.line = 2;
        headingCache.position.start.line = 2;
        app.metadataCache._getFileCache.headings.push(headingCache);

        // Heading 2
        headingCache = new HeadingCache();
        headingCache.heading = "Heading2";

        headingCache.position.end.line = 4;
        headingCache.position.start.line = 4;
        app.metadataCache._getFileCache.headings.push(headingCache);

        const result = await request(server)
          .patch(`/vault/${arbitraryFilePath}`)
          .set("Authorization", `Bearer ${API_KEY}`)
          .set("Content-Type", "text/markdown")
          .set("Heading", arbitraryHeading)
          .set("Content-Insertion-Position", "end")
          .send(arbitraryBytes)
          .expect(200);

        expect(app.vault.adapter.write).toBeTruthy();
        expect(result.text).toBeTruthy();
        expect(result.text).toEqual(
          "something\n\n# Heading1\ncontent here\nbytes\n# Heading2\nsomething"
        );
      });

      test("end content-insertion-position with header (new lines at end of header block)", async () => {
        const arbitraryFilePath = "somefile.md";
        const arbitraryBytes = "bytes";
        const arbitraryHeading = "Heading1";

        const arbitraryExistingBytes =
          "something\n\n# Heading1\ncontent here\n\n\n# Heading2\nsomething";
        app.vault._read = arbitraryExistingBytes;

        // Heading 1
        let headingCache = new HeadingCache();
        headingCache.heading = arbitraryHeading;

        headingCache.position.end.line = 2;
        headingCache.position.start.line = 2;
        app.metadataCache._getFileCache.headings.push(headingCache);

        // Heading 2
        headingCache = new HeadingCache();
        headingCache.heading = "Heading2";

        headingCache.position.end.line = 6;
        headingCache.position.start.line = 6;
        app.metadataCache._getFileCache.headings.push(headingCache);

        const result = await request(server)
          .patch(`/vault/${arbitraryFilePath}`)
          .set("Authorization", `Bearer ${API_KEY}`)
          .set("Content-Type", "text/markdown")
          .set("Heading", arbitraryHeading)
          .set("Content-Insertion-Position", "end")
          .send(arbitraryBytes)
          .expect(200);

        expect(app.vault.adapter.write).toBeTruthy();
        expect(result.text).toBeTruthy();
        expect(result.text).toEqual(
          "something\n\n# Heading1\ncontent here\n\n\nbytes\n# Heading2\nsomething"
        );
      });

      test("end content-insertion-position with header ignore newlines", async () => {
        const arbitraryFilePath = "somefile.md";
        const arbitraryBytes = "bytes";
        const arbitraryHeading = "Heading1";

        const arbitraryExistingBytes =
          "something\n\n# Heading1\ncontent here\n\n\n# Heading2\nsomething";
        app.vault._read = arbitraryExistingBytes;

        // Heading 1
        let headingCache = new HeadingCache();
        headingCache.heading = arbitraryHeading;

        headingCache.position.end.line = 2;
        headingCache.position.start.line = 2;
        app.metadataCache._getFileCache.headings.push(headingCache);

        // Heading 2
        headingCache = new HeadingCache();
        headingCache.heading = "Heading2";

        headingCache.position.end.line = 6;
        headingCache.position.start.line = 6;
        app.metadataCache._getFileCache.headings.push(headingCache);

        const result = await request(server)
          .patch(`/vault/${arbitraryFilePath}`)
          .set("Authorization", `Bearer ${API_KEY}`)
          .set("Content-Type", "text/markdown")
          .set("Heading", arbitraryHeading)
          .set("Content-Insertion-Position", "end")
          .set("Content-Insertion-Ignore-Newline", "true")
          .send(arbitraryBytes)
          .expect(200);

        expect(app.vault.adapter.write).toBeTruthy();
        expect(result.text).toBeTruthy();
        expect(result.text).toEqual(
          "something\n\n# Heading1\ncontent here\nbytes\n\n\n# Heading2\nsomething"
        );
      });
    });
  });

  describe("commandGet", () => {
    test("acceptable", async () => {
      const arbitraryCommand = new Command();
      arbitraryCommand.id = "beep";
      arbitraryCommand.name = "boop";

      app.commands.commands[arbitraryCommand.id] = arbitraryCommand;

      const result = await request(server)
        .get(`/commands/`)
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);

      expect(result.body.commands).toEqual([
        {
          id: arbitraryCommand.id,
          name: arbitraryCommand.name,
        },
      ]);
    });

    test("unauthorized", async () => {
      const arbitraryCommand = new Command();
      arbitraryCommand.id = "beep";
      arbitraryCommand.name = "boop";

      app.commands.commands[arbitraryCommand.id] = arbitraryCommand;

      await request(server).get(`/commands/`).expect(401);
    });
  });

  describe("commandPost", () => {
    test("acceptable", async () => {
      const arbitraryCommand = new Command();
      arbitraryCommand.id = "beep";
      arbitraryCommand.name = "boop";

      app.commands.commands[arbitraryCommand.id] = arbitraryCommand;

      await request(server)
        .post(`/commands/${arbitraryCommand.id}/`)
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(204);

      expect(app._executeCommandById).toEqual([arbitraryCommand.id]);
    });

    test("unauthorized", async () => {
      const arbitraryCommand = new Command();
      arbitraryCommand.id = "beep";
      arbitraryCommand.name = "boop";

      app.commands.commands[arbitraryCommand.id] = arbitraryCommand;

      await request(server)
        .post(`/commands/${arbitraryCommand.id}`)
        .expect(401);
    });
  });

  describe("searchSimplePost", () => {
    beforeEach(() => {
      // Setup mock for prepareSimpleSearch
      _prepareSimpleSearchMock.behavior = (query: string) => {
        const queryLower = query.toLowerCase();
        const queryLength = query.length;
        return (text: string) => {
          const textLower = text.toLowerCase();
          const matches: [number, number][] = [];
          let index = 0;

          // Find all matches (case-insensitive)
          while ((index = textLower.indexOf(queryLower, index)) !== -1) {
            matches.push([index, index + queryLength]);
            index += 1;
          }

          if (matches.length === 0) {
            return null;
          }

          // Calculate score based on number of matches
          const score = matches.length;

          return {
            score,
            matches,
          } as SearchResult;
        };
      };
    });

    afterEach(() => {
      // Clean up mock
      _prepareSimpleSearchMock.behavior = null;
    });

    test("match at beginning of filename", async () => {
      const testFile = new TFile();
      testFile.basename = "Master Plan";
      testFile.path = "Master Plan.md";

      app.vault._markdownFiles = [testFile];
      app.vault._cachedRead = "Some content here";

      const result = await request(server)
        .post("/search/simple/?query=Master")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);

      expect(result.body).toHaveLength(1);
      expect(result.body[0].filename).toBe("Master Plan.md");
      expect(result.body[0].matches).toHaveLength(1);
      expect(result.body[0].matches[0].match.source).toBe("filename");
      expect(result.body[0].matches[0].match.start).toBe(0);
      expect(result.body[0].matches[0].match.end).toBe(6);
      expect(result.body[0].matches[0].context).toBe("Master Plan");
    });

    test("match in middle of filename", async () => {
      const testFile = new TFile();
      testFile.basename = "1 - Master Plan";
      testFile.path = "1 - Master Plan.md";

      app.vault._markdownFiles = [testFile];
      app.vault._cachedRead = "Some content here";

      const result = await request(server)
        .post("/search/simple/?query=Master")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);

      expect(result.body).toHaveLength(1);
      expect(result.body[0].filename).toBe("1 - Master Plan.md");
      expect(result.body[0].matches).toHaveLength(1);
      expect(result.body[0].matches[0].match.source).toBe("filename");
      expect(result.body[0].matches[0].match.start).toBe(4);
      expect(result.body[0].matches[0].match.end).toBe(10);
      expect(result.body[0].matches[0].context).toBe("1 - Master Plan");
    });

    test("match at end of filename", async () => {
      const testFile = new TFile();
      testFile.basename = "My Master Plan";
      testFile.path = "My Master Plan.md";

      app.vault._markdownFiles = [testFile];
      app.vault._cachedRead = "Some content here";

      const result = await request(server)
        .post("/search/simple/?query=Plan")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);

      expect(result.body).toHaveLength(1);
      expect(result.body[0].filename).toBe("My Master Plan.md");
      expect(result.body[0].matches).toHaveLength(1);
      expect(result.body[0].matches[0].match.source).toBe("filename");
      expect(result.body[0].matches[0].match.start).toBe(10);
      expect(result.body[0].matches[0].match.end).toBe(14);
      expect(result.body[0].matches[0].context).toBe("My Master Plan");
    });

    test("match in content only", async () => {
      const testFile = new TFile();
      testFile.basename = "Random Note";
      testFile.path = "Random Note.md";

      app.vault._markdownFiles = [testFile];
      app.vault._cachedRead = "This is my master plan for the project.";

      const result = await request(server)
        .post("/search/simple/?query=master")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);

      expect(result.body).toHaveLength(1);
      expect(result.body[0].filename).toBe("Random Note.md");
      expect(result.body[0].matches).toHaveLength(1);
      expect(result.body[0].matches[0].match.source).toBe("content");
      expect(result.body[0].matches[0].match.start).toBe(11);
      expect(result.body[0].matches[0].match.end).toBe(17);
    });

    test("match in both filename and content", async () => {
      const testFile = new TFile();
      testFile.basename = "Master Plan";
      testFile.path = "Master Plan.md";

      app.vault._markdownFiles = [testFile];
      app.vault._cachedRead = "The master plan is to complete this project.";

      const result = await request(server)
        .post("/search/simple/?query=master")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);

      expect(result.body).toHaveLength(1);
      expect(result.body[0].filename).toBe("Master Plan.md");
      expect(result.body[0].matches).toHaveLength(2);

      // First match should be in filename (case-insensitive)
      expect(result.body[0].matches[0].match.source).toBe("filename");
      expect(result.body[0].matches[0].match.start).toBe(0);
      expect(result.body[0].matches[0].match.end).toBe(6);
      expect(result.body[0].matches[0].context).toBe("Master Plan");

      // Second match should be in content
      expect(result.body[0].matches[1].match.source).toBe("content");
      expect(result.body[0].matches[1].match.start).toBe(4);
      expect(result.body[0].matches[1].match.end).toBe(10);
    });

    test("multiple matches in filename", async () => {
      const testFile = new TFile();
      testFile.basename = "Test Test Test";
      testFile.path = "Test Test Test.md";

      app.vault._markdownFiles = [testFile];
      app.vault._cachedRead = "Content without the search term";

      const result = await request(server)
        .post("/search/simple/?query=Test")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);

      expect(result.body).toHaveLength(1);
      expect(result.body[0].filename).toBe("Test Test Test.md");
      expect(result.body[0].matches).toHaveLength(3);

      // All matches should be in filename
      expect(result.body[0].matches[0].match.source).toBe("filename");
      expect(result.body[0].matches[0].match.start).toBe(0);
      expect(result.body[0].matches[0].match.end).toBe(4);

      expect(result.body[0].matches[1].match.source).toBe("filename");
      expect(result.body[0].matches[1].match.start).toBe(5);
      expect(result.body[0].matches[1].match.end).toBe(9);

      expect(result.body[0].matches[2].match.source).toBe("filename");
      expect(result.body[0].matches[2].match.start).toBe(10);
      expect(result.body[0].matches[2].match.end).toBe(14);
    });

    test("filename with special characters", async () => {
      const testFile = new TFile();
      testFile.basename = "Project (2024) - Master Plan";
      testFile.path = "Project (2024) - Master Plan.md";

      app.vault._markdownFiles = [testFile];
      app.vault._cachedRead = "Project details";

      const result = await request(server)
        .post("/search/simple/?query=2024")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);

      expect(result.body).toHaveLength(1);
      expect(result.body[0].filename).toBe("Project (2024) - Master Plan.md");
      expect(result.body[0].matches).toHaveLength(1);
      expect(result.body[0].matches[0].match.source).toBe("filename");
      expect(result.body[0].matches[0].match.start).toBe(9);
      expect(result.body[0].matches[0].match.end).toBe(13);
      expect(result.body[0].matches[0].context).toBe("Project (2024) - Master Plan");
    });

    test("context length for content matches", async () => {
      const testFile = new TFile();
      testFile.basename = "Note";
      testFile.path = "Note.md";

      const longContent = "A".repeat(200) + "MATCH" + "B".repeat(200);
      app.vault._markdownFiles = [testFile];
      app.vault._cachedRead = longContent;

      const result = await request(server)
        .post("/search/simple/?query=MATCH&contextLength=50")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);

      expect(result.body).toHaveLength(1);
      expect(result.body[0].matches).toHaveLength(1);
      expect(result.body[0].matches[0].match.source).toBe("content");

      // Context should be approximately 50 chars before + match + 50 chars after
      const context = result.body[0].matches[0].context;
      expect(context.length).toBeLessThanOrEqual(105); // 50 + 5 + 50
      expect(context).toContain("MATCH");
    });

    test("no matches returns empty array", async () => {
      const testFile = new TFile();
      testFile.basename = "Random Note";
      testFile.path = "Random Note.md";

      app.vault._markdownFiles = [testFile];
      app.vault._cachedRead = "Some content";

      const result = await request(server)
        .post("/search/simple/?query=NonExistentTerm")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);

      expect(result.body).toHaveLength(0);
    });

    test("case insensitive search", async () => {
      const testFile = new TFile();
      testFile.basename = "MASTER Plan";
      testFile.path = "MASTER Plan.md";

      app.vault._markdownFiles = [testFile];
      app.vault._cachedRead = "master plan details";

      const result = await request(server)
        .post("/search/simple/?query=master")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);

      expect(result.body).toHaveLength(1);
      expect(result.body[0].matches).toHaveLength(2);

      // Should match "MASTER" in filename (case-insensitive)
      expect(result.body[0].matches[0].match.source).toBe("filename");
      expect(result.body[0].matches[0].match.start).toBe(0);
      expect(result.body[0].matches[0].match.end).toBe(6);

      // Should match "master" in content
      expect(result.body[0].matches[1].match.source).toBe("content");
      expect(result.body[0].matches[1].match.start).toBe(0);
      expect(result.body[0].matches[1].match.end).toBe(6);
    });

    test("boundary-spanning matches are filtered out", async () => {
      // This test verifies that matches spanning from filename into content are skipped.
      // When searching for a term that bridges the filename and content (e.g., "Master\n\nThe"),
      // such matches would produce invalid results (negative start positions).
      const testFile = new TFile();
      testFile.basename = "Master";
      testFile.path = "Master.md";

      app.vault._markdownFiles = [testFile];
      app.vault._cachedRead = "The content starts here";

      // Mock prepareSimpleSearch to return a boundary-spanning match
      _prepareSimpleSearchMock.behavior = (query: string) => {
        return (text: string) => {
          // Simulate a match that spans from filename into content
          // filename "Master" + "\n\n" = 8 chars (positionOffset)
          // A boundary-spanning match would have start < 8 and end > 8
          const matches: [number, number][] = [
            [0, 11], // Spans from "Master" (0) into content "The" (ends at 11)
          ];
          return {
            score: 1,
            matches,
          } as SearchResult;
        };
      };

      const result = await request(server)
        .post("/search/simple/?query=Master%0A%0AThe")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);

      // The file should still be in results (because there was a match)
      expect(result.body).toHaveLength(1);
      // But the boundary-spanning match should be filtered out
      expect(result.body[0].matches).toHaveLength(0);
    });

    test("boundary-spanning matches don't affect valid matches", async () => {
      // Verify that when there are both boundary-spanning and valid matches,
      // only the valid ones are returned
      const testFile = new TFile();
      testFile.basename = "Master";
      testFile.path = "Master.md";

      app.vault._markdownFiles = [testFile];
      app.vault._cachedRead = "The Master plan content";

      // Mock prepareSimpleSearch to return both valid and boundary-spanning matches
      _prepareSimpleSearchMock.behavior = (query: string) => {
        return (text: string) => {
          // text = "Master\n\n" + "The Master plan content"
          // positionOffset = 8
          const matches: [number, number][] = [
            [0, 11],  // Boundary-spanning: starts in filename, ends in content (should be filtered)
            [0, 6],   // Valid: entirely in filename "Master" (should be kept)
            [12, 18], // Valid: "Master" in content at position 4, adjusted = 12-8=4, 18-8=10 (should be kept)
          ];
          return {
            score: 3,
            matches,
          } as SearchResult;
        };
      };

      const result = await request(server)
        .post("/search/simple/?query=Master")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(200);

      expect(result.body).toHaveLength(1);
      // Only 2 valid matches should be returned (boundary-spanning filtered out)
      expect(result.body[0].matches).toHaveLength(2);

      // First match: filename
      expect(result.body[0].matches[0].match.source).toBe("filename");
      expect(result.body[0].matches[0].match.start).toBe(0);
      expect(result.body[0].matches[0].match.end).toBe(6);

      // Second match: content (position adjusted by positionOffset)
      expect(result.body[0].matches[1].match.source).toBe("content");
      expect(result.body[0].matches[1].match.start).toBe(4);  // 12 - 8
      expect(result.body[0].matches[1].match.end).toBe(10);   // 18 - 8
    });

    test("unauthorized", async () => {
      await request(server)
        .post("/search/simple/?query=test")
        .expect(401);
    });

    test("missing query parameter", async () => {
      await request(server)
        .post("/search/simple/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .expect(400);
    });
  });

  describe("waitForFileCache", () => {
    test("returns immediately if cache is already available", async () => {
      const testFile = new TFile();
      testFile.path = "test.md";

      // Cache is already available (default mock behavior)
      app.metadataCache._getFileCache = {
        headings: [],
        frontmatter: { title: "Test" },
        tags: [],
      };

      // Access the private method via the handler instance
      // @ts-ignore: Accessing private method for testing
      const result = await handler.waitForFileCache(testFile);

      expect(result).not.toBeNull();
      expect(result?.frontmatter?.title).toBe("Test");
    });

    test("waits for cache change event when cache is initially null", async () => {
      const testFile = new TFile();
      testFile.path = "test.md";

      // Start with null cache
      app.metadataCache._getFileCache = null;

      // @ts-ignore: Accessing private method for testing
      const cachePromise = handler.waitForFileCache(testFile, 5000);

      // Simulate cache becoming available after a short delay
      setTimeout(() => {
        app.metadataCache._getFileCache = {
          headings: [],
          frontmatter: { title: "Loaded" },
          tags: [],
        };
        app.metadataCache._emitChanged(testFile);
      }, 50);

      const result = await cachePromise;

      expect(result).not.toBeNull();
      expect(result?.frontmatter?.title).toBe("Loaded");
    });

    test("ignores cache change events for other files", async () => {
      const testFile = new TFile();
      testFile.path = "test.md";

      const otherFile = new TFile();
      otherFile.path = "other.md";

      // Start with null cache
      app.metadataCache._getFileCache = null;

      // @ts-ignore: Accessing private method for testing
      const cachePromise = handler.waitForFileCache(testFile, 200);

      // Emit change for a different file - should be ignored
      setTimeout(() => {
        app.metadataCache._emitChanged(otherFile);
      }, 20);

      // Then emit for the correct file
      setTimeout(() => {
        app.metadataCache._getFileCache = {
          headings: [],
          frontmatter: { title: "Correct" },
          tags: [],
        };
        app.metadataCache._emitChanged(testFile);
      }, 50);

      const result = await cachePromise;

      expect(result).not.toBeNull();
      expect(result?.frontmatter?.title).toBe("Correct");
    });

    test("returns current cache state on timeout", async () => {
      const testFile = new TFile();
      testFile.path = "test.md";

      // Start with null cache and never populate it
      app.metadataCache._getFileCache = null;

      // Use a very short timeout for the test
      // @ts-ignore: Accessing private method for testing
      const result = await handler.waitForFileCache(testFile, 100);

      // Should return null (timeout reached without cache becoming available)
      expect(result).toBeNull();
    });

    test("cleans up event listener after cache becomes available", async () => {
      const testFile = new TFile();
      testFile.path = "test.md";

      // Start with null cache
      app.metadataCache._getFileCache = null;

      // @ts-ignore: Accessing private method for testing
      const cachePromise = handler.waitForFileCache(testFile, 5000);

      // Simulate cache becoming available
      setTimeout(() => {
        app.metadataCache._getFileCache = {
          headings: [],
          frontmatter: {},
          tags: [],
        };
        app.metadataCache._emitChanged(testFile);
      }, 50);

      await cachePromise;

      // Check that the listener was removed
      const listeners = app.metadataCache._listeners.get("changed") || [];
      expect(listeners.length).toBe(0);
    });

    test("cleans up event listener on timeout", async () => {
      const testFile = new TFile();
      testFile.path = "test.md";

      // Start with null cache
      app.metadataCache._getFileCache = null;

      // @ts-ignore: Accessing private method for testing
      await handler.waitForFileCache(testFile, 100);

      // Check that the listener was removed after timeout
      const listeners = app.metadataCache._listeners.get("changed") || [];
      expect(listeners.length).toBe(0);
    });
  });
});
