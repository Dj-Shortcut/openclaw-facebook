import type { ErrorRequestHandler } from "express";

type ParserError = Error & {
  status?: number;
  type?: string;
};

export const bodyParserErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  const parserError = err as ParserError;

  if (parserError.status === 413 || parserError.type === "entity.too.large") {
    res.status(413).json({
      error: "Payload too large",
      message: "Request body exceeds the 10mb limit.",
    });
    return;
  }

  next(err);
};
