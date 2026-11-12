// Copied from too-much-tools (MIT, Copyright (c) 2026 Too Much Tools contributors),
// commit 8aa4902, src/tools/csharp-to-json/logic.test.ts. See THIRD_PARTY.md.
import { describe, expect, it } from 'vitest';
import { csharpToJson, jsonToCsharp, parseClasses } from './logic';

const SIMPLE = `
public class UserResponse
{
    public string Name { get; set; }
    public int Age { get; set; }
    public bool Active { get; set; }
    public AddressDto Address { get; set; }
    public List<string> Tags { get; set; }
}

public class AddressDto
{
    public string City { get; set; }
}
`;

describe('csharp-to-json loose mode', () => {
  it('maps primitives, nested types and lists', () => {
    const json = JSON.parse(csharpToJson(SIMPLE));
    expect(json).toEqual({
      Name: '',
      Age: 0,
      Active: false,
      Address: { City: '' },
      Tags: [],
    });
  });

  it('applies camelCase when requested', () => {
    const json = JSON.parse(csharpToJson(SIMPLE, { camelCase: true }));
    expect(Object.keys(json)).toContain('name');
    expect(json.address).toEqual({ city: '' });
  });

  it('tolerates namespace, usings and attributes', () => {
    const code = `
      namespace Example;
      using System;

      [ApiController]
      public class Example
      {
          [JsonPropertyName("id")]
          public Guid Id { get; set; }
          public int? Score { get; set; }
          public DateTime CreatedAt { get; set; }
      }`;
    const json = JSON.parse(csharpToJson(code));
    expect(json.Id).toBe('');
    expect(json.Score).toBeNull();
    expect(json.CreatedAt).toBe('');
  });

  it('handles positional records', () => {
    const json = JSON.parse(csharpToJson(`public record Point(int X, int Y);`));
    expect(json).toEqual({ X: 0, Y: 0 });
  });

  it('handles Dictionary and arrays', () => {
    const code = `public class C {
      public Dictionary<string,int> Map { get; set; }
      public string[] Names { get; set; }
    }`;
    const json = JSON.parse(csharpToJson(code));
    expect(json.Map).toEqual({});
    expect(json.Names).toEqual([]);
  });

  it('finds all declared types', () => {
    expect(parseClasses(SIMPLE).map((c) => c.name)).toEqual(['UserResponse', 'AddressDto']);
  });

  it('fills example values when requested', () => {
    const code = `public class C {
      public string Name { get; set; }
      public int Age { get; set; }
      public bool Active { get; set; }
      public double Score { get; set; }
      public List<string> Tags { get; set; }
    }`;
    const json = JSON.parse(csharpToJson(code, { sampleValues: true }));
    expect(json.Name).toBe('string');
    expect(json.Age).toBe(123);
    expect(json.Active).toBe(true);
    expect(json.Score).toBe(123.45);
    expect(json.Tags).toEqual(['string']); // arrays get a sample element
  });

  it('throws when no type is present', () => {
    expect(() => csharpToJson('just some text')).toThrow();
  });

  it('resolves Nullable<T> to null like T?', () => {
    const code = `public class C { public Nullable<int> Age { get; set; } }`;
    const json = JSON.parse(csharpToJson(code));
    expect(json.Age).toBeNull();
  });

  it('guards against self-referencing types instead of recursing forever', () => {
    const code = `public class Node {
      public string Name { get; set; }
      public Node Next { get; set; }
    }`;
    const json = JSON.parse(csharpToJson(code));
    expect(json.Name).toBe('');
    expect(json.Next).toEqual({});
  });

  it('sampleArrayItems alone fills arrays without upgrading scalars to sample values', () => {
    const code = `public class C { public List<string> Tags { get; set; } public int Count { get; set; } }`;
    const json = JSON.parse(csharpToJson(code, { sampleArrayItems: true }));
    expect(json.Tags).toEqual(['']); // one element, but still the empty-default scalar
    expect(json.Count).toBe(0); // not upgraded to a sample value
  });

  it('picks the first declared type as root when none reference each other', () => {
    const code = `
      public class First { public int A { get; set; } }
      public class Second { public int B { get; set; } }
    `;
    const json = JSON.parse(csharpToJson(code));
    expect(json).toEqual({ A: 0 });
  });
});

describe('jsonToCsharp (reverse)', () => {
  it('generates classes with inferred types', () => {
    const cs = jsonToCsharp(
      '{"id":1,"name":"Ada","active":true,"score":9.5,"tags":["a"],"address":{"city":"X"}}',
    );
    expect(cs).toContain('public class Root');
    expect(cs).toContain('public int Id { get; set; }');
    expect(cs).toContain('public string Name { get; set; }');
    expect(cs).toContain('public bool Active { get; set; }');
    expect(cs).toContain('public double Score { get; set; }');
    expect(cs).toContain('public List<string> Tags { get; set; }');
    expect(cs).toContain('public Address Address { get; set; }');
    expect(cs).toContain('public class Address');
  });

  it('models arrays of objects and singularizes item class', () => {
    const cs = jsonToCsharp('{"items":[{"x":1}]}');
    expect(cs).toContain('public List<Item> Items { get; set; }');
    expect(cs).toContain('public class Item');
  });

  it("adds JsonPropertyName when the key isn't PascalCase", () => {
    const cs = jsonToCsharp('{"user_id":1}');
    expect(cs).toContain('[JsonPropertyName("user_id")]');
    expect(cs).toContain('public int UserId { get; set; }');
  });

  it('supports records', () => {
    expect(jsonToCsharp('{"a":1}', { useRecords: true })).toContain('public record Root');
  });

  it('throws on malformed JSON input', () => {
    expect(() => jsonToCsharp('{not valid json')).toThrow();
  });

  it('throws when the JSON root is a bare scalar', () => {
    expect(() => jsonToCsharp('5')).toThrow();
  });

  it('throws when an array contains no objects to model', () => {
    expect(() => jsonToCsharp('[1, 2, 3]')).toThrow();
  });

  it('infers long for integers outside the 32-bit range', () => {
    const cs = jsonToCsharp('{"big":9999999999}');
    expect(cs).toContain('public long Big { get; set; }');
  });
});
