// What Twoody uses of two packages that ship no types (src/email/).

declare module "mailparser" {
  export interface EmailAddress {
    name?: string;
    address?: string;
    group?: EmailAddress[];
  }
  export interface AddressObject {
    value: EmailAddress[];
    text?: string;
  }
  export interface Attachment {
    filename?: string;
    contentType?: string;
    size?: number;
    contentDisposition?: string;
    related?: boolean;
  }
  export interface ParsedMail {
    subject?: string;
    from?: AddressObject;
    to?: AddressObject | AddressObject[];
    cc?: AddressObject | AddressObject[];
    replyTo?: AddressObject;
    date?: Date;
    messageId?: string;
    inReplyTo?: string;
    references?: string | string[];
    text?: string;
    html?: string | false;
    attachments?: Attachment[];
    /// Header names in lower case.
    headers?: Map<string, unknown>;
  }
  export interface ParserOptions {
    skipHtmlToText?: boolean;
    skipImageLinks?: boolean;
    skipTextToHtml?: boolean;
    skipTextLinks?: boolean;
    maxHtmlLengthToParse?: number;
  }
  export function simpleParser(source: Buffer | string, options?: ParserOptions): Promise<ParsedMail>;
}

declare module "html-to-text" {
  export function convert(html: string, options?: Record<string, unknown>): string;
}
