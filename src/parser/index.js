"use strict";

const assert = require("assert");

const logger = require("prettier/src/cli/logger");
const { verbatimPrint } = require("../printer/verbatim");
const { serializeRawTree } = require("./wrapper");
const { preprocess } = require("./preprocessor");
const tokens = require("../printer/tokens");

function massage(node) {
  if (node.presence === "Missing") {
    return;
  }

  let {
    tokenKind: token,
    kind: type,
    value,
    text,
    layout,
    leadingTrivia,
    trailingTrivia
  } = node;

  if (token) {
    ({ kind: type, text } = token);
    token = true;
  }

  if (layout) {
    layout = layout.map(massage).filter(v => v);
  }

  if (type === "UnknownDecl") {
    if (layout.some(n => n.type == "kw_extension")) {
      type = "_ExtensionDecl";
    } else if (layout.some(n => n.type == "kw_enum")) {
      type = "_EnumDecl";
    } else if (layout.some(n => n.type == "kw_init")) {
      type = "_InitDecl";
    } else if (layout.some(n => n.type == "kw_case")) {
      type = "_CaseDecl";
    } else if (layout.some(n => n.type == "kw_deinit")) {
      type = "_DeinitDecl";
    } else if (layout.some(n => n.type == "kw_class")) {
      type = "ClassDecl";
    } else if (layout.some(n => n.type == "kw_associatedtype")) {
      type = "_AssociatedTypeDecl";
    } else if (layout.some(n => n.type == "kw_subscript")) {
      type = "_SubscriptDecl";
      const first = layout.shift();
      const last = layout.pop();
      const arrowIndex = layout.findIndex(n => n.type === "arrow");

      if (arrowIndex >= 0) {
        layout = [
          first,
          {
            type: "FunctionSignature",
            layout: [
              ...layout.slice(0, arrowIndex),
              {
                type: "ReturnClause",
                layout: layout.slice(arrowIndex)
              }
            ]
          },
          last
        ];
      } else {
        layout = [
          first,
          {
            type: "FunctionSignature",
            layout: layout
          },
          last
        ];
      }
    } else if (layout.some(n => n.type == "pound_if")) {
      type = "_IfWithElseConfigDecl";
    }
  } else if (type === "UnknownStmt") {
    if (layout[0].type === "kw_switch") {
      type = "_SwitchStmt";
      const leftIndex = layout.findIndex(n => n.type == "l_brace");
      const rightIndex = layout.findIndex(n => n.type == "r_brace");
      const body = layout.splice(leftIndex + 1, rightIndex - leftIndex - 1);
      const cases = [];

      for (let i = 0; i < body.length; i++) {
        if (body[i].type === "kw_case" || body[i].type === "kw_default") {
          cases.push({
            type: "_SwitchCase",
            layout: [body[i]]
          });
        } else if (body[i].type === "StmtList") {
          cases[cases.length - 1].layout.push({
            type: "_CaseBlock",
            layout: [body[i]]
          });
        } else {
          cases[cases.length - 1].layout.push(body[i]);
        }
      }

      layout.splice(leftIndex + 1, 0, {
        type: "_SwitchCaseList",
        layout: cases
      });
    }
  } else if (type === "UnknownExpr") {
    if (layout.length === 1 && layout[0].token) {
      const t = layout[0];
      ({ token, type, value, text, layout } = t);

      if (t.leadingTrivia) {
        leadingTrivia = (leadingTrivia || []).concat(t.leadingTrivia);
      }

      if (t.trailingTrivia) {
        trailingTrivia = (trailingTrivia || []).concat(t.trailingTrivia);
      }
    } else if (
      layout.length === 2 &&
      layout[0].type == "l_square" &&
      layout[1].type == "r_square"
    ) {
      type = "ArrayExpr";
      layout.splice(1, 0, {
        type: "ArrayElementList",
        layout: []
      });
    } else if (
      layout.length == 2 &&
      layout[0].type === "identifier" &&
      layout[1].type === "GenericArgumentClause"
    ) {
      type = "_GenericTypeExpr";
    } else if (
      layout.length == 3 &&
      layout[0].type == "IdentifierExpr" &&
      layout[1].type == "period" &&
      layout[2].type == "kw_self"
    ) {
      type = "MemberAccessExpr";
    } else if (
      layout.length == 3 &&
      layout[1].type == "period" &&
      layout[2].type == "integer_literal"
    ) {
      type = "MemberAccessExpr";
    } else if (layout.length > 0 && layout[0].type == "pound_selector") {
      type = "_SelectorExpr";
    }
  }

  const massageTrivia = trivia => {
    if (!trivia || trivia.length === 0) {
      return;
    }

    trivia.forEach(trivium => {
      trivium.type = trivium.type || trivium.kind;
      delete trivium.kind;
    });

    return trivia;
  };

  const result = {
    type,
    token,
    value,
    leadingTrivia: massageTrivia(leadingTrivia),
    text,
    layout,
    trailingTrivia: massageTrivia(trailingTrivia)
  };

  Object.defineProperty(result, "nodes", {
    enumerable: false,
    get: function() {
      return this.layout;
    }
  });

  return result;
}

const findLastLeaf = curr => {
  if (!curr || curr.type == "IdentifierExpr") {
    return;
  }

  if (
    curr.type.startsWith("Unknown") ||
    curr.type.endsWith("Stmt") ||
    curr.type == "IfConfigDecl"
  ) {
    return curr;
  }

  if (curr.trailingTrivia && curr.trailingTrivia.length > 0) {
    return curr;
  }

  return (
    findLastLeaf(curr.layout && curr.layout[curr.layout.length - 1]) || curr
  );
};

function preferTrailingOverLeadingTrivia(node, path) {
  const { type, layout } = node;

  if (!layout || layout.length === 0 || node.type.startsWith("Unknown")) {
    return;
  }

  layout.forEach(child =>
    preferTrailingOverLeadingTrivia(child, [node].concat(path))
  );

  const leadingTrivia = (node.leadingTrivia || []).slice();
  const trailingTrivia = (node.trailingTrivia || []).slice();

  const elements = [];

  const canMoveUp = () => {
    switch (node.type) {
      case "StmtList":
        return path[0].type == "TopLevelCodeDecl";
      case "DeclList":
      case "SourceFile":
        return false;
      default:
        return true;
    }
  };

  if (canMoveUp()) {
    elements.push({
      parent: true,
      type: "(" + type + ")",
      trailingTrivia: leadingTrivia
    });
  }

  elements.push(...layout);
  elements.push({
    type,
    leadingTrivia: trailingTrivia
  });

  for (let leftIndex = 0; leftIndex < elements.length - 1; leftIndex++) {
    const left = elements[leftIndex];
    const right = elements[leftIndex + 1];

    if (left.type.startsWith("Unknown") || right.type.startsWith("Unknown")) {
      continue;
    }

    const rightLeadingTrivia = right.leadingTrivia;

    if (!rightLeadingTrivia || rightLeadingTrivia.length === 0) {
      continue;
    }

    const target = findLastLeaf(left);

    if (!target) {
      continue;
    }

    const targetTrailingTrivia = target.trailingTrivia || [];

    for (
      let triviumIndex = 0;
      triviumIndex < rightLeadingTrivia.length;
      triviumIndex++
    ) {
      const trivium = rightLeadingTrivia[triviumIndex];
      rightLeadingTrivia.splice(triviumIndex--, 1);
      targetTrailingTrivia.push(trivium);
    }

    if (rightLeadingTrivia.length === 0) {
      right.leadingTrivia = undefined;
    }

    if (targetTrailingTrivia.length > 0) {
      target.trailingTrivia = targetTrailingTrivia;
    }
  }

  node.leadingTrivia = leadingTrivia.length > 0 ? leadingTrivia : undefined;
  node.trailingTrivia = trailingTrivia.length > 0 ? trailingTrivia : undefined;
}

function extractComments(node) {
  const processTrivia = (trivia, resultArray, isLeading) => {
    if (!trivia) {
      return;
    }

    let consumeNewline = false;
    let onNewLine = trivia.length && trivia[0].__location.startOffset === 0;

    for (let i = 0; i < trivia.length; i++) {
      const trivium = trivia[i];
      const { type } = trivium;

      switch (type) {
        case "Space": {
          break;
        }
        case "Newline": {
          if (consumeNewline) {
            consumeNewline = false;

            trivium.value--;
            trivium.__location.startOffset++;

            // resultArray[resultArray.length - 1].__location.endOffset--;

            if (trivium.value <= 0) {
              trivia.splice(i--, 1);
            }
          } else {
            loop: while (i > 0) {
              const previous = trivia[i - 1];

              switch (previous.type) {
                case "Space": {
                  trivia.splice(--i, 1);
                  break;
                }
                case "Newline": {
                  trivium.value += previous.value;
                  trivia.splice(--i, 1);
                  break;
                }
                default: {
                  break loop;
                }
              }
            }
          }

          onNewLine = true;
          break;
        }
        case "DocLineComment":
        case "BlockComment":
        case "LineComment": {
          const { value, __location } = trivium;
          const isBlockComment = type === "BlockComment";

          const comment = {
            type: isBlockComment ? "CommentBlock" : "CommentLine",
            value: value
          };

          while (i > 0 && trivia[i - 1].type === "Space") {
            // const space = trivia[i - 1];
            // __location.startOffset = space.__location.startOffset;
            trivia.splice(--i, 1);
          }

          Object.defineProperty(comment, "__location", {
            value: __location,
            enumerable: Object.getOwnPropertyDescriptor(trivium, "__location")
              .enumerable
          });

          if (isLeading) {
            if (onNewLine && node.type !== "period") {
              onNewLine = false;
              consumeNewline = false;
              break;
            }

            if (i > 0 && trivia[i - 1].type === "Newline") {
              const newline = trivia[i - 1];
              newline.value--;
              if (newline.value <= 0) {
                trivia.splice(--i, 1);
              } else {
                newline.__location.endOffset--;
              }
            }
          } else if (onNewLine && node.type !== "period") {
            onNewLine = false;
            consumeNewline = false;
            break;
          } else {
            consumeNewline = !isBlockComment;
          }

          resultArray.push(comment);
          trivia.splice(i--, 1);
          onNewLine = false;

          break;
        }
        default: {
          throw new Error("Unexpected type: " + type);
        }
      }
    }

    trivia = trivia.filter(t => t.type != "Space");
    return trivia.length > 0 ? trivia : undefined;
  };

  // node.__leadingTrivia = node.leadingTrivia && node.leadingTrivia.slice();
  // node.__trailingTrivia = node.trailingTrivia && node.trailingTrivia.slice();

  const leadingComments = [];
  node.leadingTrivia = processTrivia(node.leadingTrivia, leadingComments, true);

  const innerComments = [];
  if (node.layout) {
    node.layout.forEach(child => innerComments.push(...extractComments(child)));
  }

  const trailingComments = [];
  node.trailingTrivia = processTrivia(node.trailingTrivia, trailingComments);
  return leadingComments.concat(innerComments, trailingComments);
}

function synthesizeLocation(node, start, text) {
  let end = start;

  const forEach = collection => {
    if (collection) {
      collection.forEach(n => {
        end = synthesizeLocation(n, end, text);
      });
    }
  };

  const outerLocation = { startOffset: end };

  forEach(node.leadingTrivia);

  const innerLocation = { startOffset: end };

  if (node.layout) {
    forEach(node.layout);
  } else {
    if (typeof node.text !== "undefined") {
      const s = node.text;
      assert.strictEqual(text.slice(end, end + s.length), s);
      end += s.length;
    } else if (typeof node.value !== "undefined") {
      if (Number.isInteger(node.value)) {
        end += node.value;
      } else {
        end += node.value.length;
      }
    } else if (node.type.startsWith("pound_")) {
      const s = "#" + node.type.slice("pound_".length);
      assert.strictEqual(text.slice(end, end + s.length), s);
      end += s.length;
    } else if (node.type.startsWith("kw_")) {
      const s = node.type.slice("kw_".length);
      assert.strictEqual(text.slice(end, end + s.length), s);
      end += s.length;
    } else if (tokens.hasOwnProperty(node.type)) {
      const s = tokens[node.type];
      assert.strictEqual(text.slice(end, end + s.length), s);
      end += s.length;
    } else {
      throw new Error(
        "Don't know how to express " +
          JSON.stringify(node.type) +
          ":\n" +
          JSON.stringify(node, null, 2)
      );
    }
  }

  innerLocation.endOffset = end;

  forEach(node.trailingTrivia);

  outerLocation.endOffset = end;

  const location = node.layout ? outerLocation : innerLocation;

  Object.defineProperty(node, "__location", {
    value: location,
    enumerable: false
  });

  return end;
}

function parse(text) {
  let ast = serializeRawTree(text);

  if (preprocess(ast)) {
    logger.warn(
      "libSwift had issues parsing this file. Re-writing and parsing it again..."
    );
    text = verbatimPrint(ast);
    ast = serializeRawTree(text);
  }

  ast = massage(ast);
  preferTrailingOverLeadingTrivia(ast, []);
  const end = synthesizeLocation(ast, 0, text);

  assert.strictEqual(end, text.length);

  ast.comments = extractComments(ast);

  Object.defineProperty(ast, "__text", {
    value: text,
    enumerable: false
  });

  return ast;
}

module.exports = parse;