declare module "textures" {
  interface TextureBase {
    (selection: d3.Selection<any, any, any, any>): void;
    url(): string;
    id(): string;
    id(value: string): this;
  }

  interface LinesTexture extends TextureBase {
    size(): number;
    size(value: number): this;
    strokeWidth(): number;
    strokeWidth(value: number): this;
    stroke(): string;
    stroke(value: string): this;
    background(): string;
    background(value: string): this;
    orientation(): string[];
    orientation(...args: string[]): this;
    shapeRendering(): string;
    shapeRendering(value: string): this;
    heavier(multiplier?: number): this;
    lighter(multiplier?: number): this;
    thinner(multiplier?: number): this;
    thicker(multiplier?: number): this;
  }

  interface CirclesTexture extends TextureBase {
    size(): number;
    size(value: number): this;
    radius(): number;
    radius(value: number): this;
    fill(): string;
    fill(value: string): this;
    stroke(): string;
    stroke(value: string): this;
    strokeWidth(): number;
    strokeWidth(value: number): this;
    background(): string;
    background(value: string): this;
    complement(): this;
    heavier(multiplier?: number): this;
    lighter(multiplier?: number): this;
    thinner(multiplier?: number): this;
    thicker(multiplier?: number): this;
  }

  interface PathsTexture extends TextureBase {
    size(): number;
    size(value: number): this;
    d(): string | ((size: number) => string);
    d(value: string | ((size: number) => string)): this;
    fill(): string;
    fill(value: string): this;
    stroke(): string;
    stroke(value: string): this;
    strokeWidth(): number;
    strokeWidth(value: number): this;
    background(): string;
    background(value: string): this;
    shapeRendering(): string;
    shapeRendering(value: string): this;
    heavier(multiplier?: number): this;
    lighter(multiplier?: number): this;
    thinner(multiplier?: number): this;
    thicker(multiplier?: number): this;
  }

  interface Textures {
    lines(): LinesTexture;
    circles(): CirclesTexture;
    paths(): PathsTexture;
  }

  const textures: Textures;
  export default textures;
}
