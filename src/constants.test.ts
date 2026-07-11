import { ErrorCode } from "./types";
import { ERROR_CODE_MESSAGES } from "./constants";

describe("ERROR_CODE_MESSAGES", () => {
  test("has an entry for every ErrorCode value", () => {
    const definedCodes = Object.values(ErrorCode).filter(
      (v): v is ErrorCode => typeof v === "number"
    );
    for (const code of definedCodes) {
      expect(ERROR_CODE_MESSAGES).toHaveProperty(
        String(code),
        expect.any(String)
      );
    }
  });
});
