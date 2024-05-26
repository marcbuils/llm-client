import type {
  TextResponse,
  TextResponseFunctionCall,
  TextResponseResult
} from '../ai/index.js';
import type { AITextChatRequest } from '../index.js';
import {
  type AITextFunction,
  FunctionProcessor,
  Memory
} from '../text/index.js';
import type { AIService } from '../text/index.js';

import {
  type GenIn,
  type GenOut,
  Program,
  type ProgramForwardOptions
} from './program.js';
import { PromptTemplate } from './prompt.js';
import {
  extractValues,
  type IField,
  Signature,
  ValidationError
} from './sig.js';

export interface GenerateOptions {
  functions?: AITextFunction[];
  functionCall?: AITextChatRequest['functionCall'];
  promptTemplate?: typeof PromptTemplate;
  asserts?: Assertion[];
}

export interface Assertion {
  fn(arg0: Record<string, unknown>): boolean;
  errMsg?: string;
  optional?: boolean;
}

export type GenerateResult<OUT extends GenOut> = OUT & {
  functions?: TextResponseFunctionCall[];
};

export class Generate<
  IN extends GenIn = GenIn,
  OUT extends GenerateResult<GenOut> = GenerateResult<GenOut>
> extends Program<IN, OUT> {
  private sigHash: string;
  private ai: AIService;
  private pt: PromptTemplate;
  private asserts: Assertion[];
  private options?: GenerateOptions;
  private funcProc?: FunctionProcessor;

  constructor(
    ai: AIService,
    signature: Readonly<Signature | string>,
    options?: Readonly<GenerateOptions>
  ) {
    super(signature);

    this.sigHash = this.signature.hash();
    this.ai = ai;
    this.options = options;
    this.pt = new (options?.promptTemplate ?? PromptTemplate)(this.signature);
    this.asserts = this.options?.asserts ?? [];

    if (this.options?.functions) {
      this.funcProc = new FunctionProcessor(this.options?.functions);
      this.updateSigForFunctions();
    }
  }

  private updateSigForFunctions = () => {
    // AI supports function calling natively so
    // no need to add fields for function call
    if (this.ai.getFeatures().functions) {
      return;
    }

    // These are the fields for the function call only needed when the underlying LLM API does not support function calling natively in the API.
    this.signature.addOutputField({
      name: 'functionName',
      description: 'Name of function to call',
      isOptional: true
    });

    this.signature.addOutputField({
      name: 'functionArguments',
      description: 'Arguments of function to call',
      isOptional: true
    });
  };

  public addAssert = (
    fn: Assertion['fn'],
    errMsg?: string,
    optional?: boolean
  ) => {
    this.asserts.push({ fn, errMsg, optional });
  };

  private _forwardCore = async ({
    mem,
    sessionId,
    traceId,
    ai,
    modelConfig: mc
  }: Readonly<ProgramForwardOptions>): Promise<TextResponseResult> => {
    const chatPrompt = mem?.history(sessionId) ?? [];

    if (chatPrompt.length === 0) {
      throw new Error('No chat prompt found');
    }

    const functions = this.options?.functions;
    const functionCall = this.options?.functionCall;
    const _ai = ai ?? this.ai;

    const hasJSON = this.signature
      .getOutputFields()
      .some((f) => f?.type?.name === 'json' || f?.type?.isArray);

    const modelConfig = mc
      ? {
          ...mc,
          ...(hasJSON ? { outputFormat: 'json_object' } : {})
        }
      : undefined;

    const aiRes = await _ai.chat(
      { chatPrompt, functions, functionCall, modelConfig },
      {
        ...(sessionId ? { sessionId } : {}),
        ...(traceId ? { traceId } : {})
      }
    );
    const res = aiRes as unknown as TextResponse;
    const result = res.results?.at(0);

    if (!result) {
      throw new Error('No result found');
    }

    return result;
  };

  private _forward = async ({
    mem,
    sessionId,
    traceId,
    maxCompletions,
    ai,
    modelConfig: mc
  }: Readonly<ProgramForwardOptions>): Promise<OUT> => {
    let result: TextResponseResult | undefined;

    for (let i = 0; i < (maxCompletions ?? 10); i++) {
      const res = await this._forwardCore({
        mem,
        sessionId,
        traceId,
        ai,
        modelConfig: mc
      });

      if (!result) {
        result = res;
      } else if (result.content) {
        result.content += res.content;
      }

      if (res.finishReason === 'length') {
        continue;
      }

      break;
    }

    if (!result) {
      throw new Error('No result found');
    }

    mem?.addResult(result, sessionId);

    let retval: Record<string, unknown> = {};

    if (result?.content) {
      retval = extractValues(this.signature, result.content);

      for (const a of this.asserts) {
        try {
          if (!a.fn(retval) && a.errMsg) {
            throw new AssertionError({
              message: a.errMsg,
              value: retval,
              optional: a.optional
            });
          }
        } catch (e) {
          throw new AssertionError({
            message: (e as Error).message,
            value: retval,
            optional: a.optional
          });
        }
      }
    }

    let funcs:
      | { id?: string; name: string; args?: string | object }[]
      | undefined = [];

    if (this.ai.getFeatures().functions) {
      funcs = (result.functionCalls ?? []).map((f) => ({
        id: f.id,
        name: f.function.name,
        args: f.function.arguments
      }));
    } else if (retval.functionName) {
      const { functionName, functionArguments, ...other } = retval as {
        functionName: string;
        functionArguments: string;
        other: object;
      };
      retval = { ...other };
      funcs = [
        {
          name: functionName,
          args: functionArguments
        }
      ];
    }

    const _funcs: Record<string, string | undefined> = {};
    for (const [i, f] of funcs.entries()) {
      _funcs['functionName' + i] = f.name;
      _funcs['functionArguments' + i] =
        typeof f.args === 'object' ? JSON.stringify(f.args) : f.args;
    }

    return { ...retval, functions: funcs } as unknown as OUT;
  };

  public override async forward(
    values: IN,
    options?: Readonly<ProgramForwardOptions>
  ): Promise<OUT> {
    const maxRetries = options?.maxRetries ?? 3;
    const mem = options?.mem ?? new Memory();

    let extraFields: IField[] = [];
    let err: ValidationError | AssertionError | undefined;

    if (this.sigHash !== this.signature.hash()) {
      const promptTemplate = this.options?.promptTemplate ?? PromptTemplate;
      this.pt = new promptTemplate(this.signature);
    }

    const prompt = this.pt.toString<IN>(values, {
      extraFields,
      examples: this.examples,
      demos: this.demos
    });

    const userMsg = { role: 'user' as const, content: prompt };
    mem?.add(userMsg, options?.sessionId);

    for (let i = 0; i < maxRetries; i++) {
      try {
        for (let n = 0; n < (options?.maxSteps ?? 10); n++) {
          const res = await this._forward({
            ...options,
            mem
          });

          const result = await this.processResult(res, {
            ...options,
            mem
          });

          if (result) {
            this.setTrace({
              ...values,
              ...res
            });

            return result;
          }
        }
        throw new Error('Could not complete task within maximum allowed steps');
      } catch (e) {
        if (e instanceof ValidationError) {
          const f = e.getField();

          extraFields = [
            {
              name: `past_${f.name}`,
              title: `Past ${f.title}`,
              description: e.getValue()
            },
            {
              name: 'instructions',
              title: 'Instructions',
              description: e.message
            }
          ];

          err = e;
        } else if (e instanceof AssertionError) {
          const e1 = e as AssertionError;
          extraFields = [];

          for (const f of this.signature.getOutputFields()) {
            const values = e1.getValue();
            extraFields.push({
              name: `past_${f.name}`,
              title: `Past ${f.title}`,
              description: JSON.stringify(values[f.name])
            });
          }

          extraFields.push({
            name: 'instructions',
            title: 'Instructions',
            description: e1.message
          });
          err = e;
        } else {
          throw e;
        }
      }
    }

    if (err instanceof AssertionError && err.getOptional()) {
      return err.getValue() as OUT;
    }

    throw new Error(`Unable to fix validation error: ${err?.message}`);
  }

  public processResult = async (
    res: Readonly<OUT & { functions?: TextResponseFunctionCall[] }>,
    options?: Readonly<ProgramForwardOptions>
  ): Promise<(OUT & { reason: string }) | undefined> => {
    if (res.functions === undefined) {
      return res as OUT & { reason: string };
    }

    if (res.functions.length === 0) {
      delete (res as Record<string, unknown>).functions;
      return res as OUT & { reason: string };
    }

    for (const func of res.functions) {
      if (func.name.indexOf('task_done') !== -1) {
        delete (res as Record<string, unknown>).functions;
        return res as OUT & { reason: string };
      }

      const fres = await this.funcProc?.execute(func, {
        sessionId: options?.sessionId,
        traceId: options?.traceId
      });

      if (fres?.id) {
        options?.mem?.add(
          [
            {
              role: 'function' as const,
              content: fres.result ?? '',
              functionId: fres.id
            }
          ],
          options.sessionId
        );
      }
    }
  };
}

export class AssertionError extends Error {
  private value: Record<string, unknown>;
  private optional?: boolean;

  constructor({
    message,
    value
  }: Readonly<{
    message: string;
    value: Record<string, unknown>;
    optional?: boolean;
  }>) {
    super(message);
    this.value = value;
    this.name = this.constructor.name;
    this.stack = new Error().stack;
  }
  public getValue = () => this.value;
  public getOptional = () => this.optional;
}
