/* eslint-disable no-shadow */
import type { Page, CDPSession } from 'puppeteer';
// eslint-disable-next-line import/no-unresolved
import type Protocol from 'devtools-protocol';

import { RawData, WebSocket } from 'ws';

export interface PageHandlerProps {
  ws?: WebSocket;
  page: Page;
  targetId: string;
  debug: debug.Debugger;
  serverBaseUrl: string;
}

export enum SpecialCommands {
  START_SCREENCAST = 'Page.startScreencast',
  SET_VIEWPORT = 'Page.setViewport',
}

export enum MiscCommands {
  RELOAD = 'Page.reload',
  NAVIGATE_TO_HISTORY_ENTRY = 'Page.navigateToHistoryEntry',
  EMULATE_TOUCH_FROM_MOUSE = 'Input.emulateTouchFromMouseEvent',
  DISPACTCH_KEY = 'Input.dispatchKeyEvent',
  SCREENCAST_ACK = 'Page.screencastFrameAck',
}

export type MiscCommandRequest =
  | {
  command: MiscCommands.RELOAD;
  params: Protocol.Page.ReloadRequest;
}
  | {
  command: MiscCommands.NAVIGATE_TO_HISTORY_ENTRY;
  params: Protocol.Page.NavigateToHistoryEntryRequest;
}
  | {
  command: MiscCommands.EMULATE_TOUCH_FROM_MOUSE;
  params: Protocol.Input.EmulateTouchFromMouseEventRequest;
}
  | {
  command: MiscCommands.DISPACTCH_KEY;
  params: Protocol.Input.DispatchKeyEventRequest;
}
  | {
  command: MiscCommands.SCREENCAST_ACK;
  params: Protocol.Page.ScreencastFrameAckRequest;
};

export type CommandRequest =
  | {
  command: SpecialCommands.START_SCREENCAST;
  params: Protocol.Page.StartScreencastRequest;
}
  | {
  command: SpecialCommands.SET_VIEWPORT;
  params: Protocol.Page.SetDeviceMetricsOverrideRequest;
}
  | MiscCommandRequest;

export type CommandResponse = {
  command: 'Page.screencastFrame';
  data: Protocol.Page.ScreencastFrameEvent;
};

export class PageHandler {
  private page: Page;

  private ws?: WebSocket;

  private cdpSession: CDPSession | undefined;

  private debug: debug.Debugger;

  private videoEncoderPage?: Page;

  private serverBaseUrl: string;

  private videoEncoderWidth: number = 0;

  private videoEncoderHeight: number = 0;

  constructor(props: PageHandlerProps) {
    this.debug = props.debug.extend(props.targetId);
    this.page = props.page;
    this.serverBaseUrl = props.serverBaseUrl;
    if (props.ws) this.setWs(props.ws);
    this.debug('Created pageHandler');
  }

  private async safeFn<T>(fn: () => Promise<T>): Promise<T | void> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof Error) {
        this.debug(err.message);
      } else {
        this.debug(err);
      }
      return undefined;
    }
  }

  public setWs(ws: WebSocket): void {
    this.debug('Setting websocket');
    if (this.ws) this.ws.close();
    this.closeVideoEncoderPage();
    this.ws = ws;
    ws.on('message', this.messageHandler.bind(this));
    ws.on('error', this.onError.bind(this));
    ws.on('close', () => {
      if (this.cdpSession) {
        this.cdpSession.send('Page.stopScreencast');
      }
      this.closeVideoEncoderPage();
    });
  }

  closeVideoEncoderPage() {
    if (this.videoEncoderPage) {
      this.videoEncoderPage.close();
      this.videoEncoderPage = undefined;
      this.videoEncoderWidth = 0;
      this.videoEncoderHeight = 0;
    }
  }

  public async close(): Promise<void> {
    this.debug('Closing websocket');
    if (this.ws) this.ws.close();
    await this.safeFn(async () => {
      if (this.cdpSession) return this.cdpSession.detach();
      return undefined;
    });
    if (this.videoEncoderPage) {
      await this.safeFn(async () => {
        this.closeVideoEncoderPage();
      });
    }
  }

  private async getCdpSession(): Promise<CDPSession> {
    if (!this.cdpSession) {
      this.cdpSession = await this.page.target().createCDPSession();
      this.cdpSession.on('error', (e) => this.debug(e));
    }
    return this.cdpSession;
  }

  private onError(err: unknown) {
    this.debug(err);
  }

  private async messageHandler(data: RawData): Promise<void> {
    const dataString = data.toString();
    const commandRequest = JSON.parse(dataString) as CommandRequest;
    if (commandRequest.command !== MiscCommands.EMULATE_TOUCH_FROM_MOUSE) {
      this.debug('Received message: %s', dataString);
    }
    if (commandRequest.command === SpecialCommands.START_SCREENCAST) {
      return this.startScreencast(commandRequest.params);
    }
    if (commandRequest.command === SpecialCommands.SET_VIEWPORT) {
      return this.setViewPort(commandRequest.params);
    }
    return this.sendMiscCommand(commandRequest);
  }

  private async setViewPort(data: Protocol.Page.SetDeviceMetricsOverrideRequest) {
    await this.safeFn(() => this.page.setViewport(data));
    await this.safeFn(async () => {
      if (this.videoEncoderPage) {
        await this.configVideoEncoder(data.width, data.height);
      }
    });
  }

  private async createVideoEncoder() {
    if (!this.videoEncoderPage) {
      console.log('creating videoEncoderPage');
      this.videoEncoderPage = await this.page.browserContext().newPage();
      await this.videoEncoderPage.exposeFunction('sendMessageToController', (msg: any) => {
        console.log('receive msg from video encoder');
        if (!this.ws) {
          console.log('discard msg from video encoder: websocket not exist');
          return;
        }
        if (msg.type === 'videoChunk') {
          console.log('videoChunk delay: ', Date.now() - msg.data.timestamp / 1000);
        }
        this.ws.send(Buffer.from(JSON.stringify({
          command: msg.type,
          data: msg.data
        })));
      });
      await this.videoEncoderPage.goto(this.serverBaseUrl + '/video-encoder.html');
      console.log('videoEncoderPage created');
    }
  }

  private async configVideoEncoder(width: number, height: number) {
    if (!this.videoEncoderPage) {
      throw new Error('configVideoEncoder failed: videoEncoderPage is null');
    }
    if (this.videoEncoderWidth !== width || this.videoEncoderHeight !== height) {
      console.log('start to configVideoEncoder');
      await this.videoEncoderPage.evaluate((viewportWidth, viewportHeight) => {
        // @ts-ignore
        configVideoEncoder(viewportWidth, viewportHeight);
      }, width, height);
      this.videoEncoderWidth = width;
      this.videoEncoderHeight = height;
      console.log('configVideoEncoder ok');
    }
  }

  private async startScreencast(params: Protocol.Page.StartScreencastRequest): Promise<void> {
    const client = await this.getCdpSession();
    await this.createVideoEncoder();
    const viewport = this.page.viewport();
    if (!viewport) {
      throw new Error('startScreencast failed: viewport is null');
    }
    await this.configVideoEncoder(viewport.width, viewport.height);
    await this.safeFn(() => client.send('Page.startScreencast', params));
    client.on('Page.screencastFrame', this.onScreencastFrame.bind(this));
  }

  private onScreencastFrame(data: Protocol.Page.ScreencastFrameEvent): void {
    this.debug('Got screencast frame: %j', { sessionId: data.sessionId, metadata: data.metadata });
      // @ts-ignore
    console.log('screencast frame delay: ', Date.now() - data.metadata.timestamp * 1000);
    const commandResponse: CommandResponse = { command: 'Page.screencastFrame', data };
    // if (!this.ws) throw new Error('Websocket not set for page');
    // this.ws.send(Buffer.from(JSON.stringify(commandResponse)));
    if (this.cdpSession) {
      console.log('Page.screencastFrameAck sent');
      this.cdpSession.send('Page.screencastFrameAck', { sessionId: data.sessionId });
    } else {
      console.log('Page.screencastFrameAck not send');
    }
    if (this.videoEncoderPage) {
      const startSending=Date.now()
      this.videoEncoderPage.evaluate(async (imageData, metadata) => {
        const start=Date.now()
        // @ts-ignore
        const success=await onGetImageData(imageData, metadata);
        return {
          success,
          time:Date.now()-start
        }
      }, data.data, data.metadata).then(result => {
        if (!result.success) {
          console.log('discard screencast frame: video encoder is overwhelmed');
        }else{
          console.log('onGetImageData delay: total=%d, inPage=%d', Date.now() - startSending, result.time);
        }
      });
    } else {
      console.log('discard screencast frame: videoEncoderPage not exist');
    }
  }

  private async sendMiscCommand(commandRequest: MiscCommandRequest): Promise<void> {
    const client = await this.getCdpSession();
    if (Object.values(MiscCommands).includes(commandRequest.command)) {
      return this.safeFn(() => client.send(commandRequest.command, commandRequest.params as never));
    }
    return undefined;
  }

}
