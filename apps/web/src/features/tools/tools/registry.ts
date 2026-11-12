// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/registry.ts. See THIRD_PARTY.md.
import type { ToolEntry } from '@/features/tools/lib/tool-sdk';

// --- Tool definitions (lightweight metadata, safe to import eagerly) ---------
import stringLength from './string-length/definition';
import base64 from './base64/definition';
import jsonViewer from './json-viewer/definition';
import textCompare from './text-compare/definition';
import idGenerator from './id-generator/definition';
import appsettingsEnv from './appsettings-env/definition';
import csharpToJson from './csharp-to-json/definition';
import regexTester from './regex-tester/definition';
import cronViewer from './cron-viewer/definition';
import markdownViewer from './markdown-viewer/definition';
import jwtDecoder from './jwt-decoder/definition';
import jsonDiff from './json-diff/definition';
import hashGenerator from './hash-generator/definition';
import urlEncode from './url-encode/definition';
import urlParser from './url-parser/definition';
import caseConverter from './case-converter/definition';
import timestamp from './timestamp/definition';
import sqlFormatter from './sql-formatter/definition';
import jsonYaml from './json-yaml/definition';
import jsonXml from './json-xml/definition';
import jsonCsv from './json-csv/definition';
import csharpTypescript from './csharp-typescript/definition';
import jsonSchema from './json-schema/definition';
import jsonpath from './jsonpath/definition';
import escape from './escape/definition';
import connectionString from './connection-string/definition';
import queryString from './query-string/definition';
import httpMime from './http-mime/definition';
import unicodeInspector from './unicode-inspector/definition';
import jsonExcel from './json-excel/definition';
import passwordGenerator from './password-generator/definition';
import aes from './aes/definition';
import rsaKeygen from './rsa-keygen/definition';
import loremIpsum from './lorem-ipsum/definition';
import fakeData from './fake-data/definition';
import csvViewer from './csv-viewer/definition';
import xmlFormatter from './xml-formatter/definition';
import sqlToJson from './sql-to-json/definition';
import sqlParameterizer from './sql-parameterizer/definition';
import configValidator from './config-validator/definition';
import openapi from './openapi/definition';
import htmlMarkdown from './html-markdown/definition';
import codeFormatter from './code-formatter/definition';
import datetimePlayground from './datetime-playground/definition';
import imageCompressor from './image-compressor/definition';
import base64Image from './base64-image/definition';
import qrGenerator from './qr-generator/definition';
import barcodeGenerator from './barcode-generator/definition';
import backgroundRemover from './background-remover/definition';
import smartPaste from './smart-paste/definition';
import jsonString from './json-string/definition';
import dataSize from './data-size/definition';
import binaryText from './binary-text/definition';
import numberBase from './number-base/definition';
import asciiTable from './ascii-table/definition';
import ipv4SubnetCalculator from './ipv4-subnet-calculator/definition';
import ipv4AddressConverter from './ipv4-address-converter/definition';
import ipv4RangeExpander from './ipv4-range-expander/definition';
import ipv6UlaGenerator from './ipv6-ula-generator/definition';
import macAddressGenerator from './mac-address-generator/definition';
import macAddressLookup from './mac-address-lookup/definition';
import bcryptTool from './bcrypt-tool/definition';
import totpGenerator from './totp-generator/definition';
import passwordStrengthAnalyser from './password-strength-analyser/definition';
import basicAuthGenerator from './basic-auth-generator/definition';
import bip39Generator from './bip39-generator/definition';
import colorConverter from './color-converter/definition';
import romanNumeralConverter from './roman-numeral-converter/definition';
import temperatureConverter from './temperature-converter/definition';
import textToNato from './text-to-nato/definition';
import jsonToml from './json-toml/definition';
import yamlToml from './yaml-toml/definition';
import chmodCalculator from './chmod-calculator/definition';
import dockerRunToCompose from './docker-run-to-compose/definition';
import userAgentParser from './user-agent-parser/definition';
import metaTagGenerator from './meta-tag-generator/definition';
import slugifyString from './slugify-string/definition';
import emailNormalizer from './email-normalizer/definition';
import safelinkDecoder from './safelink-decoder/definition';
import keycodeInfo from './keycode-info/definition';
import htmlWysiwygEditor from './html-wysiwyg-editor/definition';
import yamlViewer from './yaml-viewer/definition';
import listConverter from './list-converter/definition';
import mathEvaluator from './math-evaluator/definition';
import stringObfuscator from './string-obfuscator/definition';
import numeronymGenerator from './numeronym-generator/definition';
import textToUnicode from './text-to-unicode/definition';
import asciiTextDrawer from './ascii-text-drawer/definition';
import emojiPicker from './emoji-picker/definition';
import ibanValidator from './iban-validator/definition';
import phoneParser from './phone-parser/definition';
import svgPlaceholder from './svg-placeholder/definition';
import wifiQr from './wifi-qr/definition';
import percentageCalculator from './percentage-calculator/definition';
import etaCalculator from './eta-calculator/definition';
import randomPort from './random-port/definition';
import benchmarkBuilder from './benchmark-builder/definition';
import chronometer from './chronometer/definition';
import deviceInformation from './device-information/definition';
import gitMemo from './git-memo/definition';

/**
 * The single source of truth for installed tools.
 *
 * Adding a tool means: create `src/tools/<id>/{definition,component,logic}.ts`
 * then add ONE entry below. No switch statements, no edits elsewhere. The
 * `load` thunk is a dynamic import so each tool is code-split, opening one
 * tool never downloads another's JavaScript.
 *
 * `scripts/create-tool.mjs` automates both steps.
 */
export const TOOL_ENTRIES: ToolEntry[] = [
  { definition: stringLength, load: () => import('./string-length/component') },
  { definition: base64, load: () => import('./base64/component') },
  { definition: jsonViewer, load: () => import('./json-viewer/component') },
  { definition: textCompare, load: () => import('./text-compare/component') },
  { definition: idGenerator, load: () => import('./id-generator/component') },
  { definition: appsettingsEnv, load: () => import('./appsettings-env/component') },
  { definition: csharpToJson, load: () => import('./csharp-to-json/component') },
  { definition: regexTester, load: () => import('./regex-tester/component') },
  { definition: cronViewer, load: () => import('./cron-viewer/component') },
  { definition: markdownViewer, load: () => import('./markdown-viewer/component') },
  { definition: jwtDecoder, load: () => import('./jwt-decoder/component') },
  { definition: jsonDiff, load: () => import('./json-diff/component') },
  { definition: hashGenerator, load: () => import('./hash-generator/component') },
  { definition: urlEncode, load: () => import('./url-encode/component') },
  { definition: urlParser, load: () => import('./url-parser/component') },
  { definition: caseConverter, load: () => import('./case-converter/component') },
  { definition: timestamp, load: () => import('./timestamp/component') },
  { definition: sqlFormatter, load: () => import('./sql-formatter/component') },
  { definition: jsonYaml, load: () => import('./json-yaml/component') },
  { definition: jsonXml, load: () => import('./json-xml/component') },
  { definition: jsonCsv, load: () => import('./json-csv/component') },
  { definition: csharpTypescript, load: () => import('./csharp-typescript/component') },
  { definition: jsonSchema, load: () => import('./json-schema/component') },
  { definition: jsonpath, load: () => import('./jsonpath/component') },
  { definition: escape, load: () => import('./escape/component') },
  { definition: connectionString, load: () => import('./connection-string/component') },
  { definition: queryString, load: () => import('./query-string/component') },
  { definition: httpMime, load: () => import('./http-mime/component') },
  { definition: unicodeInspector, load: () => import('./unicode-inspector/component') },
  { definition: jsonExcel, load: () => import('./json-excel/component') },
  { definition: passwordGenerator, load: () => import('./password-generator/component') },
  { definition: aes, load: () => import('./aes/component') },
  { definition: rsaKeygen, load: () => import('./rsa-keygen/component') },
  { definition: loremIpsum, load: () => import('./lorem-ipsum/component') },
  { definition: fakeData, load: () => import('./fake-data/component') },
  { definition: csvViewer, load: () => import('./csv-viewer/component') },
  { definition: xmlFormatter, load: () => import('./xml-formatter/component') },
  { definition: sqlToJson, load: () => import('./sql-to-json/component') },
  { definition: sqlParameterizer, load: () => import('./sql-parameterizer/component') },
  { definition: configValidator, load: () => import('./config-validator/component') },
  { definition: openapi, load: () => import('./openapi/component') },
  { definition: htmlMarkdown, load: () => import('./html-markdown/component') },
  { definition: codeFormatter, load: () => import('./code-formatter/component') },
  { definition: datetimePlayground, load: () => import('./datetime-playground/component') },
  { definition: imageCompressor, load: () => import('./image-compressor/component') },
  { definition: base64Image, load: () => import('./base64-image/component') },
  { definition: qrGenerator, load: () => import('./qr-generator/component') },
  { definition: barcodeGenerator, load: () => import('./barcode-generator/component') },
  { definition: backgroundRemover, load: () => import('./background-remover/component') },
  { definition: smartPaste, load: () => import('./smart-paste/component') },
  { definition: jsonString, load: () => import('./json-string/component') },
  { definition: dataSize, load: () => import('./data-size/component') },
  { definition: binaryText, load: () => import('./binary-text/component') },
  { definition: numberBase, load: () => import('./number-base/component') },
  { definition: asciiTable, load: () => import('./ascii-table/component') },
  { definition: ipv4SubnetCalculator, load: () => import('./ipv4-subnet-calculator/component') },
  { definition: ipv4AddressConverter, load: () => import('./ipv4-address-converter/component') },
  { definition: ipv4RangeExpander, load: () => import('./ipv4-range-expander/component') },
  { definition: ipv6UlaGenerator, load: () => import('./ipv6-ula-generator/component') },
  { definition: macAddressGenerator, load: () => import('./mac-address-generator/component') },
  { definition: macAddressLookup, load: () => import('./mac-address-lookup/component') },
  { definition: bcryptTool, load: () => import('./bcrypt-tool/component') },
  { definition: totpGenerator, load: () => import('./totp-generator/component') },
  {
    definition: passwordStrengthAnalyser,
    load: () => import('./password-strength-analyser/component'),
  },
  { definition: basicAuthGenerator, load: () => import('./basic-auth-generator/component') },
  { definition: bip39Generator, load: () => import('./bip39-generator/component') },
  { definition: colorConverter, load: () => import('./color-converter/component') },
  { definition: romanNumeralConverter, load: () => import('./roman-numeral-converter/component') },
  { definition: temperatureConverter, load: () => import('./temperature-converter/component') },
  { definition: textToNato, load: () => import('./text-to-nato/component') },
  { definition: jsonToml, load: () => import('./json-toml/component') },
  { definition: yamlToml, load: () => import('./yaml-toml/component') },
  { definition: chmodCalculator, load: () => import('./chmod-calculator/component') },
  { definition: dockerRunToCompose, load: () => import('./docker-run-to-compose/component') },
  { definition: userAgentParser, load: () => import('./user-agent-parser/component') },
  { definition: metaTagGenerator, load: () => import('./meta-tag-generator/component') },
  { definition: slugifyString, load: () => import('./slugify-string/component') },
  { definition: emailNormalizer, load: () => import('./email-normalizer/component') },
  { definition: safelinkDecoder, load: () => import('./safelink-decoder/component') },
  { definition: keycodeInfo, load: () => import('./keycode-info/component') },
  { definition: htmlWysiwygEditor, load: () => import('./html-wysiwyg-editor/component') },
  { definition: yamlViewer, load: () => import('./yaml-viewer/component') },
  { definition: listConverter, load: () => import('./list-converter/component') },
  { definition: mathEvaluator, load: () => import('./math-evaluator/component') },
  { definition: stringObfuscator, load: () => import('./string-obfuscator/component') },
  { definition: numeronymGenerator, load: () => import('./numeronym-generator/component') },
  { definition: textToUnicode, load: () => import('./text-to-unicode/component') },
  { definition: asciiTextDrawer, load: () => import('./ascii-text-drawer/component') },
  { definition: emojiPicker, load: () => import('./emoji-picker/component') },
  { definition: ibanValidator, load: () => import('./iban-validator/component') },
  { definition: phoneParser, load: () => import('./phone-parser/component') },
  { definition: svgPlaceholder, load: () => import('./svg-placeholder/component') },
  { definition: wifiQr, load: () => import('./wifi-qr/component') },
  { definition: percentageCalculator, load: () => import('./percentage-calculator/component') },
  { definition: etaCalculator, load: () => import('./eta-calculator/component') },
  { definition: randomPort, load: () => import('./random-port/component') },
  { definition: benchmarkBuilder, load: () => import('./benchmark-builder/component') },
  { definition: chronometer, load: () => import('./chronometer/component') },
  { definition: deviceInformation, load: () => import('./device-information/component') },
  { definition: gitMemo, load: () => import('./git-memo/component') },
];
