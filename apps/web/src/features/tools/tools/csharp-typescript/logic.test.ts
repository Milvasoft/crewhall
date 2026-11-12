// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/csharp-typescript/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { csharpToTypeScript, typeScriptToCsharp } from './logic';

const CS = `public class User
{
    public string Name { get; set; }
    public int Age { get; set; }
    public bool Active { get; set; }
    public int? Score { get; set; }
    public List<string> Tags { get; set; }
    public Dictionary<string, int> Counts { get; set; }
}`;

describe('csharp → typescript', () => {
  it('maps primitives, nullable, list and dictionary', () => {
    const ts = csharpToTypeScript(CS);
    expect(ts).toContain('export interface User {');
    expect(ts).toContain('Name: string;');
    expect(ts).toContain('Age: number;');
    expect(ts).toContain('Active: boolean;');
    expect(ts).toContain('Score: number | null;');
    expect(ts).toContain('Tags: string[];');
    expect(ts).toContain('Counts: Record<string, number>;');
  });

  it('throws when there is no class, record or struct', () => {
    expect(() => csharpToTypeScript('')).toThrow('No C# class, record or struct found.');
    expect(() => csharpToTypeScript('namespace Foo { }')).toThrow();
  });

  it('emits an interface per class when several are present', () => {
    const ts = csharpToTypeScript(
      `public class A { public string X { get; set; } }\npublic class B { public int Y { get; set; } }`,
    );
    expect(ts).toContain('export interface A {');
    expect(ts).toContain('export interface B {');
    expect(ts).toContain('X: string;');
    expect(ts).toContain('Y: number;');
  });

  it('strips fully-qualified namespaces from types', () => {
    const ts = csharpToTypeScript(
      'public class Q { public System.String Name { get; set; } public System.Collections.Generic.List<int> Nums { get; set; } }',
    );
    expect(ts).toContain('Name: string;');
    expect(ts).toContain('Nums: number[];');
  });

  it('unwraps nested generics, Task<T>, and object/dynamic', () => {
    const ts = csharpToTypeScript(
      'public class N { public List<List<int>> Grid { get; set; } public Task<string> Label { get; set; } public object Blob { get; set; } public dynamic Thing { get; set; } }',
    );
    expect(ts).toContain('Grid: number[][];');
    expect(ts).toContain('Label: string;');
    expect(ts).toContain('Blob: unknown;');
    expect(ts).toContain('Thing: unknown;');
  });
});

describe('typescript → csharp', () => {
  it('maps types and optional properties', () => {
    const ts = `export interface User {
      name: string;
      age: number;
      active: boolean;
      score?: number;
      tags: string[];
    }`;
    const cs = typeScriptToCsharp(ts);
    expect(cs).toContain('public class User');
    expect(cs).toContain('public string Name { get; set; }');
    expect(cs).toContain('public double Age { get; set; }');
    expect(cs).toContain('public bool Active { get; set; }');
    expect(cs).toContain('public double? Score { get; set; }');
    expect(cs).toContain('public List<string> Tags { get; set; }');
  });

  it('adds JsonPropertyName for camelCase keys', () => {
    const cs = typeScriptToCsharp('interface X { user_name: string; }');
    expect(cs).toContain('[JsonPropertyName("user_name")]');
    expect(cs).toContain('public string UserName { get; set; }');
  });

  it('throws when nothing to parse', () => {
    expect(() => typeScriptToCsharp('const x = 1;')).toThrow();
  });

  it('throws when an interface has no field-shaped members', () => {
    expect(() => typeScriptToCsharp('interface X { greet(): void; }')).toThrow(
      'No TypeScript interface or type found.',
    );
  });

  it("maps Record<K,V>, Array<T> and Date, and 'any'/'unknown' to object", () => {
    const cs = typeScriptToCsharp(
      `interface X {
        counts: Record<string, number>;
        tags: Array<string>;
        created: Date;
        blob: any;
        misc: unknown;
      }`,
    );
    expect(cs).toContain('public Dictionary<string, double> Counts { get; set; }');
    expect(cs).toContain('public List<string> Tags { get; set; }');
    expect(cs).toContain('public DateTime Created { get; set; }');
    expect(cs).toContain('public object Blob { get; set; }');
    expect(cs).toContain('public object Misc { get; set; }');
  });

  it("treats an explicit '| null' union as nullable even without '?'", () => {
    const cs = typeScriptToCsharp('interface X { score: number | null; }');
    expect(cs).toContain('public double? Score { get; set; }');
  });

  it('emits one C# class per interface when several are present', () => {
    const cs = typeScriptToCsharp(`interface A { x: string; }\ninterface B { y: number; }`);
    expect(cs).toContain('public class A');
    expect(cs).toContain('public class B');
  });
});
