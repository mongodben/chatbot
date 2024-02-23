import { TextClassificationPipeline } from "@xenova/transformers";
export async function makeBgeRerankerBooster() {
  // this hackery explained - https://stackoverflow.com/questions/76883048/err-require-esm-for-import-with-xenova-transformers
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pipeline = (await Function('return import("@xenova/transformers")')())
    .pipeline;
  const task = "text-classification";
  // model: https://huggingface.co/Xenova/bge-reranker-large
  const model = "'Xenova/bge-reranker-large'";
  const classify = (await pipeline(task, model)) as TextClassificationPipeline;

  return {
    async classify(s: string[] | string) {
      return await classify(s);
    },
  };
}
