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

  describe("searchFulltextPost", () => {
    test("missing query parameter", async () => {
      await request(server)
        .post("/search/fulltext/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({})
        .expect(400);
    });

    test("invalid path with directory traversal", async () => {
      await request(server)
        .post("/search/fulltext/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({
          query: "test",
          path: "../etc"
        })
        .expect(400);
    });

    test("absolute path rejected", async () => {
      await request(server)
        .post("/search/fulltext/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({
          query: "test",
          path: "/etc/passwd"
        })
        .expect(400);
    });

    test("unauthorized request", async () => {
      await request(server)
        .post("/search/fulltext/")
        .send({
          query: "test"
        })
        .expect(401);
    });

    test("successful search with results", async () => {
      // Set up mock files with content
      const file1 = new TFile();
      file1.path = "notes/getting-started.md";
      
      const file2 = new TFile();
      file2.path = "projects/work-notes.md";
      
      app.vault._markdownFiles = [file1, file2];
      
      // Mock file contents that contain our search term
      const mockContent1 = "Welcome to your Obsidian vault! This powerful tool helps you organize notes.";
      const mockContent2 = "The Obsidian vault system allows you to manage your knowledge effectively.";
      
      // Set up cachedRead to return different content based on file
      app.vault.cachedRead = jest.fn().mockImplementation((file: TFile) => {
        if (file.path === "notes/getting-started.md") return Promise.resolve(mockContent1);
        if (file.path === "projects/work-notes.md") return Promise.resolve(mockContent2);
        return Promise.resolve("");
      });

      const result = await request(server)
        .post("/search/fulltext/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({
          query: "Obsidian vault",
          contextLength: 50
        })
        .expect(200);

      expect(result.body).toHaveLength(2);
      expect(result.body[0].filename).toBe("notes/getting-started.md");
      expect(result.body[0].matches).toHaveLength(1);
      expect(result.body[0].matches[0].line).toBe(1);
      expect(result.body[0].matches[0].snippet).toContain("Obsidian vault");
      
      expect(result.body[1].filename).toBe("projects/work-notes.md");
      expect(result.body[1].matches).toHaveLength(1);
      expect(result.body[1].matches[0].snippet).toContain("Obsidian vault");
    });

    test("search with no results", async () => {
      const file1 = new TFile();
      file1.path = "notes/empty.md";
      app.vault._markdownFiles = [file1];
      
      app.vault.cachedRead = jest.fn().mockResolvedValue("Some content without the search term");

      const result = await request(server)
        .post("/search/fulltext/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({
          query: "nonexistent term"
        })
        .expect(200);

      expect(result.body).toEqual([]);
    });

    test("case sensitive search", async () => {
      const file1 = new TFile();
      file1.path = "test.md";
      app.vault._markdownFiles = [file1];
      
      app.vault.cachedRead = jest.fn().mockResolvedValue("This contains Test but not the exact case");

      // Case insensitive (default)
      let result = await request(server)
        .post("/search/fulltext/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({
          query: "test",
          caseSensitive: false
        })
        .expect(200);

      expect(result.body).toHaveLength(1);

      // Case sensitive - should not match
      result = await request(server)
        .post("/search/fulltext/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({
          query: "test", 
          caseSensitive: true
        })
        .expect(200);

      expect(result.body).toEqual([]);
    });

    test("regex search functionality", async () => {
      const file1 = new TFile();
      file1.path = "regex-test.md";
      app.vault._markdownFiles = [file1];
      
      app.vault.cachedRead = jest.fn().mockResolvedValue("Contact email: user@example.com and admin@test.org");

      const result = await request(server)
        .post("/search/fulltext/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({
          query: "\\w+@\\w+\\.\\w+",
          useRegex: true
        })
        .expect(200);

      expect(result.body).toHaveLength(1);
      expect(result.body[0].matches).toHaveLength(2); // Should find both email addresses
    });

    test("path filtering", async () => {
      const file1 = new TFile();
      file1.path = "notes/diary/day1.md";
      
      const file2 = new TFile();
      file2.path = "projects/work.md";
      
      const file3 = new TFile();
      file3.path = "notes/ideas.md";
      
      app.vault._markdownFiles = [file1, file2, file3];
      
      app.vault.cachedRead = jest.fn().mockResolvedValue("search term appears here");

      const result = await request(server)
        .post("/search/fulltext/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({
          query: "search term",
          path: "notes/"
        })
        .expect(200);

      expect(result.body).toHaveLength(2); // Should only find files in notes/ folder
      expect(result.body.map((r: any) => r.filename).sort()).toEqual([
        "notes/diary/day1.md",
        "notes/ideas.md"
      ]);
    });

    test("file extension filtering", async () => {
      const mdFile = new TFile();
      mdFile.path = "document.md";
      
      const txtFile = new TFile();
      txtFile.path = "notes.txt";
      
      app.vault._files = [mdFile, txtFile]; // Use _files for all files
      
      app.vault.cachedRead = jest.fn().mockResolvedValue("search content");

      // Search only .txt files
      const result = await request(server)
        .post("/search/fulltext/")
        .set("Authorization", `Bearer ${API_KEY}`)
        .send({
          query: "search content",
          fileExtension: ".txt"
        })
        .expect(200);

      expect(result.body).toHaveLength(1);
      expect(result.body[0].filename).toBe("notes.txt");
    });
  });

  describe("Core Search Logic Unit Tests", () => {
    // Test the actual search methods by accessing them through reflection
    // since they're private methods
    
    describe("createSearchPattern", () => {
      test("literal search escapes regex characters", () => {
        const pattern = (handler as any).createSearchPattern("hello.world+test", false, false);
        expect(pattern.source).toBe("hello\\.world\\+test");
        expect(pattern.flags).toBe("gi"); // global + case-insensitive
      });

      test("regex search uses pattern as-is", () => {
        const pattern = (handler as any).createSearchPattern("\\w+@\\w+\\.\\w+", true, false);
        expect(pattern.source).toBe("\\w+@\\w+\\.\\w+");
        expect(pattern.flags).toBe("gi");
      });

      test("case sensitive flag removes 'i' flag", () => {
        const pattern = (handler as any).createSearchPattern("test", false, true);
        expect(pattern.flags).toBe("g"); // only global, no case-insensitive
      });

      test("case insensitive includes 'i' flag", () => {
        const pattern = (handler as any).createSearchPattern("test", false, false);
        expect(pattern.flags).toBe("gi"); // global + case-insensitive
      });
    });

    describe("findMatchesInContent", () => {
      test("finds single match with correct position", () => {
        const searchPattern = new RegExp("test", "gi");
        const content = "This is a test line";
        const matches = (handler as any).findMatchesInContent(content, searchPattern, 50);
        
        expect(matches).toHaveLength(1);
        expect(matches[0].line).toBe(1);
        expect(matches[0].snippet).toBe("This is a test line");
        expect(matches[0].matchStart).toBe(10);
        expect(matches[0].matchEnd).toBe(14);
      });

      test("finds multiple matches on same line", () => {
        const searchPattern = new RegExp("test", "gi");
        const content = "test this test again";
        const matches = (handler as any).findMatchesInContent(content, searchPattern, 50);
        
        expect(matches).toHaveLength(2);
        expect(matches[0].matchStart).toBe(0);
        expect(matches[0].matchEnd).toBe(4);
        expect(matches[1].matchStart).toBe(10);
        expect(matches[1].matchEnd).toBe(14);
      });

      test("finds matches across multiple lines", () => {
        const searchPattern = new RegExp("important", "gi");
        const content = "Line 1 has important info\nLine 2 is normal\nLine 3 has important data";
        const matches = (handler as any).findMatchesInContent(content, searchPattern, 20);
        
        expect(matches).toHaveLength(2);
        expect(matches[0].line).toBe(1);
        expect(matches[1].line).toBe(3);
      });

      test("respects context window boundaries", () => {
        const searchPattern = new RegExp("match", "gi");
        const content = "This is a very long line with match in the middle and more text after";
        const matches = (handler as any).findMatchesInContent(content, searchPattern, 10);
        
        expect(matches).toHaveLength(1);
        // The actual implementation extracts 10 chars before and after the match
        // "match" starts at index 35, so contextStart = 25, contextEnd = 50
        // Expected snippet: "line with match in the mi" (25 chars)
        expect(matches[0].snippet).toBe("line with match in the mi");
        expect(matches[0].matchStart).toBe(10); // Position within the snippet
        expect(matches[0].matchEnd).toBe(15);
      });

      test("handles regex patterns correctly", () => {
        const searchPattern = new RegExp("\\w+@\\w+\\.\\w+", "gi");
        const content = "Contact: user@example.com or admin@test.org for help";
        const matches = (handler as any).findMatchesInContent(content, searchPattern, 30);
        
        expect(matches).toHaveLength(2);
        expect(matches[0].snippet).toContain("user@example.com");
        expect(matches[1].snippet).toContain("admin@test.org");
      });

      test("case sensitivity works correctly", () => {
        const caseSensitivePattern = new RegExp("Test", "g"); // No 'i' flag
        const content = "This Test and test are different";
        const matches = (handler as any).findMatchesInContent(content, caseSensitivePattern, 50);
        
        expect(matches).toHaveLength(1); // Only finds "Test", not "test"
        expect(matches[0].snippet).toContain("Test");
      });

      test("handles empty content", () => {
        const searchPattern = new RegExp("test", "gi");
        const content = "";
        const matches = (handler as any).findMatchesInContent(content, searchPattern, 50);
        
        expect(matches).toEqual([]);
      });

      test("handles no matches", () => {
        const searchPattern = new RegExp("nonexistent", "gi");
        const content = "This content has nothing matching the search";
        const matches = (handler as any).findMatchesInContent(content, searchPattern, 50);
        
        expect(matches).toEqual([]);
      });
    });

    describe("getFilesToSearch", () => {
      beforeEach(() => {
        // Reset mock files before each test
        app.vault._files = [];
        app.vault._markdownFiles = [];
      });

      test("returns all files for .* extension", () => {
        const file1 = new TFile();
        file1.path = "document.md";
        const file2 = new TFile();
        file2.path = "notes.txt";
        const file3 = new TFile();
        file3.path = "image.png";
        
        app.vault._files = [file1, file2, file3];
        
        const files = (handler as any).getFilesToSearch(".*", "");
        expect(files).toHaveLength(3);
        expect(files).toEqual([file1, file2, file3]);
      });

      test("returns only markdown files for .md extension", () => {
        const mdFile = new TFile();
        mdFile.path = "document.md";
        const txtFile = new TFile();
        txtFile.path = "notes.txt";
        
        app.vault._markdownFiles = [mdFile];
        app.vault._files = [mdFile, txtFile];
        
        const files = (handler as any).getFilesToSearch(".md", "");
        expect(files).toHaveLength(1);
        expect(files[0]).toBe(mdFile);
      });

      test("returns only markdown files for 'md' extension (without dot)", () => {
        const mdFile = new TFile();
        mdFile.path = "document.md";
        
        app.vault._markdownFiles = [mdFile];
        
        const files = (handler as any).getFilesToSearch("md", "");
        expect(files).toHaveLength(1);
        expect(files[0]).toBe(mdFile);
      });

      test("filters by custom extension", () => {
        const txtFile1 = new TFile();
        txtFile1.path = "notes.txt";
        const txtFile2 = new TFile();
        txtFile2.path = "readme.txt";
        const mdFile = new TFile();
        mdFile.path = "document.md";
        
        app.vault._files = [txtFile1, txtFile2, mdFile];
        
        const files = (handler as any).getFilesToSearch(".txt", "");
        expect(files).toHaveLength(2);
        expect(files).toEqual([txtFile1, txtFile2]);
      });

      test("filters by path prefix", () => {
        const file1 = new TFile();
        file1.path = "notes/daily/day1.md";
        const file2 = new TFile();
        file2.path = "notes/ideas.md";
        const file3 = new TFile();
        file3.path = "projects/work.md";
        
        app.vault._markdownFiles = [file1, file2, file3];
        
        const files = (handler as any).getFilesToSearch(".md", "notes/");
        expect(files).toHaveLength(2);
        expect(files.map((f: TFile) => f.path)).toEqual([
          "notes/daily/day1.md",
          "notes/ideas.md"
        ]);
      });

      test("handles path without trailing slash", () => {
        const file1 = new TFile();
        file1.path = "notes/daily/day1.md";
        const file2 = new TFile();
        file2.path = "projects/work.md";
        
        app.vault._markdownFiles = [file1, file2];
        
        const files = (handler as any).getFilesToSearch(".md", "notes");
        expect(files).toHaveLength(1);
        expect(files[0].path).toBe("notes/daily/day1.md");
      });

      test("returns empty array when no files match", () => {
        const file1 = new TFile();
        file1.path = "projects/work.md";
        
        app.vault._markdownFiles = [file1];
        
        const files = (handler as any).getFilesToSearch(".md", "notes/");
        expect(files).toEqual([]);
      });

      test("combines extension and path filtering", () => {
        const txtFile = new TFile();
        txtFile.path = "notes/readme.txt";
        const mdFile1 = new TFile();
        mdFile1.path = "notes/daily.md";
        const mdFile2 = new TFile();
        mdFile2.path = "projects/work.md";
        
        app.vault._files = [txtFile, mdFile1, mdFile2];
        
        const files = (handler as any).getFilesToSearch(".txt", "notes/");
        expect(files).toHaveLength(1);
        expect(files[0].path).toBe("notes/readme.txt");
      });
    });
  });
});
