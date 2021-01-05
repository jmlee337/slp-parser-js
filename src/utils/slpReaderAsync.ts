import _ from "lodash";
import fs from "fs";
import { promisify } from "util";
import { decode } from "@shelacek/ubjson";

import { Command, EventCallbackFunc, MetadataType } from "../types";

import {
  parseMessage,
  SlpBufferSourceRef,
  SlpFileSourceRef,
  SlpFileType,
  SlpInputSource,
  SlpReadInput,
  SlpRefType,
} from "./slpReader";

const close = promisify(fs.close);
const fstat = promisify(fs.fstat);
const open = promisify(fs.open);
const read = promisify(fs.read);

async function getRef(input: SlpReadInput): Promise<SlpRefType> {
  switch (input.source) {
    case SlpInputSource.FILE:
      const fd = await open(input.filePath, "r");
      return {
        source: input.source,
        fileDescriptor: fd,
      } as SlpFileSourceRef;
    case SlpInputSource.BUFFER:
      return {
        source: input.source,
        buffer: input.buffer,
      } as SlpBufferSourceRef;
    default:
      throw new Error("Source type not supported");
  }
}

async function readRef(
  ref: SlpRefType,
  buffer: Uint8Array,
  offset: number,
  length: number,
  position: number,
): Promise<number> {
  switch (ref.source) {
    case SlpInputSource.FILE:
      return (await read((ref as SlpFileSourceRef).fileDescriptor, buffer, offset, length, position)).bytesRead;
    case SlpInputSource.BUFFER:
      return (ref as SlpBufferSourceRef).buffer.copy(buffer, offset, position, position + length);
    default:
      throw new Error("Source type not supported");
  }
}

async function getLenRef(ref: SlpRefType): Promise<number> {
  switch (ref.source) {
    case SlpInputSource.FILE:
      const fileStats = await fstat((ref as SlpFileSourceRef).fileDescriptor);
      return fileStats.size;
    case SlpInputSource.BUFFER:
      return (ref as SlpBufferSourceRef).buffer.length;
    default:
      throw new Error("Source type not supported");
  }
}

/**
 * Opens a file at path
 */
export async function openSlpFile(input: SlpReadInput): Promise<SlpFileType> {
  const ref = await getRef(input);

  const rawDataPosition = await getRawDataPosition(ref);
  const rawDataLength = await getRawDataLength(ref, rawDataPosition);
  const metadataPosition = rawDataPosition + rawDataLength + 10; // remove metadata string
  const metadataLength = await getMetadataLength(ref, metadataPosition);
  const messageSizes = await getMessageSizes(ref, rawDataPosition);

  return {
    ref: ref,
    rawDataPosition: rawDataPosition,
    rawDataLength: rawDataLength,
    metadataPosition: metadataPosition,
    metadataLength: metadataLength,
    messageSizes: messageSizes,
  };
}

export async function closeSlpFile(file: SlpFileType): Promise<void> {
  switch (file.ref.source) {
    case SlpInputSource.FILE:
      await close((file.ref as SlpFileSourceRef).fileDescriptor);
      break;
  }
}

// This function gets the position where the raw data starts
async function getRawDataPosition(ref: SlpRefType): Promise<number> {
  const buffer = new Uint8Array(1);
  await readRef(ref, buffer, 0, buffer.length, 0);

  if (buffer[0] === 0x36) {
    return 0;
  }

  if (buffer[0] !== "{".charCodeAt(0)) {
    return 0; // return error?
  }

  return 15;
}

async function getRawDataLength(ref: SlpRefType, position: number): Promise<number> {
  const fileSize = await getLenRef(ref);
  if (position === 0) {
    return fileSize;
  }

  const buffer = new Uint8Array(4);
  await readRef(ref, buffer, 0, buffer.length, position - 4);

  const rawDataLen = (buffer[0] << 24) | (buffer[1] << 16) | (buffer[2] << 8) | buffer[3];
  if (rawDataLen > 0) {
    // If this method manages to read a number, it's probably trustworthy
    return rawDataLen;
  }

  // If the above does not return a valid data length,
  // return a file size based on file length. This enables
  // some support for severed files
  return fileSize - position;
}

async function getMetadataLength(ref: SlpRefType, position: number): Promise<number> {
  const len = await getLenRef(ref);
  return len - position - 1;
}

async function getMessageSizes(
  ref: SlpRefType,
  position: number,
): Promise<{
  [command: number]: number;
}> {
  const messageSizes: {
    [command: number]: number;
  } = {};
  // Support old file format
  if (position === 0) {
    messageSizes[0x36] = 0x140;
    messageSizes[0x37] = 0x6;
    messageSizes[0x38] = 0x46;
    messageSizes[0x39] = 0x1;
    return messageSizes;
  }

  const buffer = new Uint8Array(2);
  await readRef(ref, buffer, 0, buffer.length, position);
  if (buffer[0] !== Command.MESSAGE_SIZES) {
    return {};
  }

  const payloadLength = buffer[1];
  messageSizes[0x35] = payloadLength;

  const messageSizesBuffer = new Uint8Array(payloadLength - 1);
  await readRef(ref, messageSizesBuffer, 0, messageSizesBuffer.length, position + 2);
  for (let i = 0; i < payloadLength - 1; i += 3) {
    const command = messageSizesBuffer[i];

    // Get size of command
    messageSizes[command] = (messageSizesBuffer[i + 1] << 8) | messageSizesBuffer[i + 2];
  }

  return messageSizes;
}

/**
 * Iterates through slp events and parses payloads
 */
export async function iterateEvents(
  slpFile: SlpFileType,
  callback: EventCallbackFunc,
  startPos: number | null = null,
): Promise<number> {
  const ref = slpFile.ref;

  let readPosition = startPos || slpFile.rawDataPosition;
  const stopReadingAt = slpFile.rawDataPosition + slpFile.rawDataLength;

  // Generate read buffers for each
  const commandPayloadBuffers = _.mapValues(slpFile.messageSizes, (size) => new Uint8Array(size + 1));

  const commandByteBuffer = new Uint8Array(1);
  while (readPosition < stopReadingAt) {
    await readRef(ref, commandByteBuffer, 0, 1, readPosition);
    const commandByte = commandByteBuffer[0];
    const buffer = commandPayloadBuffers[commandByte];
    if (buffer === undefined) {
      // If we don't have an entry for this command, return false to indicate failed read
      return readPosition;
    }

    if (buffer.length > stopReadingAt - readPosition) {
      return readPosition;
    }

    await readRef(ref, buffer, 0, buffer.length, readPosition);
    const parsedPayload = parseMessage(commandByte, buffer);
    const shouldStop = callback(commandByte, parsedPayload);
    if (shouldStop) {
      break;
    }

    readPosition += buffer.length;
  }

  return readPosition;
}

export async function getMetadata(slpFile: SlpFileType): Promise<MetadataType | null> {
  if (slpFile.metadataLength <= 0) {
    // This will happen on a severed incomplete file
    // $FlowFixMe
    return null;
  }

  const buffer = new Uint8Array(slpFile.metadataLength);

  await readRef(slpFile.ref, buffer, 0, buffer.length, slpFile.metadataPosition);

  let metadata = null;
  try {
    metadata = decode(buffer);
  } catch (ex) {
    // Do nothing
    // console.log(ex);
  }

  // $FlowFixMe
  return metadata;
}
