import { DEFAULT_SEMANTIC_MODEL, SEMANTIC_DIMENSIONS } from "./constants.js";

export interface TextEmbedder {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: readonly string[]): Promise<Float32Array[]>;
}

export interface TransformersEmbedderOptions {
  readonly cacheDir?: string;
  readonly allowRemoteModels?: boolean;
}

interface TensorLike {
  readonly data: ArrayLike<number>;
  readonly dims: readonly number[];
}

type Extractor = (
  input: string[],
  options: { pooling: "mean"; normalize: true },
) => Promise<TensorLike>;

interface TransformersModule {
  env: {
    cacheDir: string;
    allowRemoteModels: boolean;
  };
  pipeline(
    task: "feature-extraction",
    model: string,
  ): Promise<unknown>;
}

async function loadTransformers(): Promise<TransformersModule> {
  try {
    return await import("@huggingface/transformers") as unknown as TransformersModule;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`SEMANTIC_DEPENDENCY_UNAVAILABLE: @huggingface/transformers could not be loaded: ${detail}`);
  }
}

export class TransformersEmbedder implements TextEmbedder {
  readonly dimensions = SEMANTIC_DIMENSIONS;
  private extractorPromise?: Promise<Extractor>;

  constructor(
    readonly model = DEFAULT_SEMANTIC_MODEL,
    private readonly options: TransformersEmbedderOptions = {},
  ) {}

  private async extractor(): Promise<Extractor> {
    if (!this.extractorPromise) {
      this.extractorPromise = (async () => {
        const transformers = await loadTransformers();
        if (this.options.cacheDir !== undefined) transformers.env.cacheDir = this.options.cacheDir;
        transformers.env.allowRemoteModels = this.options.allowRemoteModels ?? true;
        return await transformers.pipeline("feature-extraction", this.model) as Extractor;
      })();
    }
    return this.extractorPromise;
  }

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const extractor = await this.extractor();
    const output = await extractor([...texts], { pooling: "mean", normalize: true });
    const batch = output.dims[0];
    const dimensions = output.dims[1];
    if (batch !== texts.length || dimensions !== this.dimensions) {
      throw new Error(
        `SEMANTIC_DIMENSION_MISMATCH: model ${this.model} produced ${String(dimensions)} dimensions for ${String(batch)} rows`,
      );
    }

    const flattened = Float32Array.from(output.data);
    const vectors: Float32Array[] = [];
    for (let index = 0; index < texts.length; index += 1) {
      const start = index * this.dimensions;
      vectors.push(flattened.slice(start, start + this.dimensions));
    }
    return vectors;
  }
}
