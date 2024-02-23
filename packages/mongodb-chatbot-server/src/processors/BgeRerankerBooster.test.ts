import { makeBgeRerankerBooster } from "./BgeRerankerBooster";
import * as types from "node:util/types";

jest.setTimeout(30000);
test("makeBgeRerankerBooster", async () => {
  // for explanation, see https://github.com/jestjs/jest/issues/11864
  // and https://github.com/microsoft/onnxruntime/issues/16622#issuecomment-1626413333
  const originalImplementation = Array.isArray;
  // @ts-ignore
  Array.isArray = (type) => {
    if (
      type?.constructor?.name === "Float32Array" ||
      type?.constructor?.name === "BigInt64Array"
    ) {
      return true;
    }

    return originalImplementation(type);
  };
  const classifier = await makeBgeRerankerBooster();
  const posRes = await classifier.classify("I love you");
  expect(posRes[0]).toBe("POSITIVE");
  const negRes = await classifier.classify("I hate you");
  expect(negRes[0]).toBe("NEGATIVE");
});
