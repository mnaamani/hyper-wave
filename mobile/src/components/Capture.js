// Lobby moment capture — the mobile counterpart of renderer/lib/proof.js. An opted-in peer frames
// its moment during the lobby countdown; the frame is captured (automatically as the countdown runs
// out, or manually earlier) and STAGED to the engine, which posts it to the gallery when this
// peer's sweep slot fires. That decouples the human moment (leisurely) from the fast sweep.
//
// Two properties this file must not lose:
//
// PRIVACY. A phone photo carries EXIF — device, timestamp, and GPS if location permission was ever
// granted. We take the picture with `exif: false` AND re-encode it through expo-image-manipulator,
// which decodes to pixels and writes a fresh JPEG. That re-encode IS the metadata strip, the same
// role the canvas plays on desktop. Never stage a camera file directly.
//
// SIZE. The engine byte-caps an entry's serialized payload at 256 KB (feed.js MAX_PAYLOAD_BYTES)
// and a payload over the cap is dropped by every peer's merge — silently, from the poster's point
// of view. A full-resolution phone frame is megabytes, so we downscale + compress down an ENCODINGS
// ladder until it fits, landing in the tens of KB like the desktop's 240x180 canvas JPEG.
import { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Modal
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { PALETTE } from '../theme';

// Encoding ladder, tried in order until the data URL fits IMAGE_BUDGET_BYTES. The first rung
// matches the desktop's 240x180 q0.5 canvas JPEG in spirit; the rest exist because phone cameras
// vary wildly and an over-cap payload is dropped SILENTLY by every peer's merge — better a smaller
// picture than an invisible one.
const ENCODINGS = [
  { width: 320, quality: 0.5 },
  { width: 240, quality: 0.4 },
  { width: 160, quality: 0.3 }
];
// Headroom under the engine's 256 KB serialized-payload cap for the caption + JSON overhead.
const IMAGE_BUDGET_BYTES = 200 * 1024;
const AUTO_CAPTURE_LEAD_MS = 2500; // fire before the lobby closes, so the frame is staged in time
const TICK_MS = 250;

/**
 * Take the current frame, strip its metadata, downscale it and return a JPEG data URL that fits
 * the engine's entry byte cap.
 * @param {Object} camera - The CameraView ref.
 * @returns {Promise<string>} The data URL, or '' if no frame could be taken (or none fits).
 */
async function grabFrame(camera) {
  if (!camera) {
    return '';
  }
  try {
    const shot = await camera.takePictureAsync({
      quality: ENCODINGS[0].quality,
      exif: false, // never carry EXIF (device / timestamp / GPS) into a public gallery
      skipProcessing: true
    });
    for (const encoding of ENCODINGS) {
      const context = ImageManipulator.manipulate(shot.uri);
      context.resize({ width: encoding.width });
      const rendered = await context.renderAsync();
      const saved = await rendered.saveAsync({
        compress: encoding.quality,
        format: SaveFormat.JPEG,
        base64: true
      });
      if (!saved.base64) {
        return '';
      }
      const dataUrl = `data:image/jpeg;base64,${saved.base64}`;
      if (dataUrl.length <= IMAGE_BUDGET_BYTES) {
        return dataUrl;
      }
    }
    // Every rung was still too big: post the caption alone rather than an entry the network drops.
    console.warn(
      '[capture] frame exceeds the entry byte cap — posting without it'
    );
    return '';
  } catch (err) {
    console.warn('[capture] could not take the frame:', err.message);
    return '';
  }
}

/**
 * The capture sheet. Open while the peer is in a forming wave's lobby.
 *
 * @param {Object} props - Props.
 * @param {boolean} props.visible - Whether the lobby capture is open.
 * @param {number} props.deadline - Date.now()-based ms when the lobby closes.
 * @param {(moment: {image: string, caption: string}) => void} props.onStage - Stage the moment.
 * @param {() => void} props.onSkip - Opt out of posting a moment this wave.
 * @param {Object} props.captureRef - Ref the host fills with { captureAndStage } (the wave-start
 *   and wave-switch hooks call it, mirroring desktop's proof.captureAndStage()).
 * @returns {JSX.Element|null} The sheet.
 */
export function Capture({ visible, deadline, onStage, onSkip, captureRef }) {
  const cameraRef = useRef(null);
  const captionRef = useRef('');
  const stagedRef = useRef(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [caption, setCaption] = useState('');
  const [secsLeft, setSecsLeft] = useState(0);
  const [busy, setBusy] = useState(false);

  // Capture + stage exactly once per wave. Exposed on `captureRef` so the host can force it when
  // the wave starts (or when the user navigates to another wave — app-core invariant 3).
  useEffect(() => {
    const captureAndStage = async () => {
      if (stagedRef.current || !visible) {
        return;
      }
      stagedRef.current = true;
      setBusy(true);
      const image = await grabFrame(cameraRef.current);
      onStage({ image, caption: captionRef.current });
      setBusy(false);
    };
    captureRef.current = { captureAndStage };
    return () => {
      captureRef.current = null;
    };
  }, [visible, onStage, captureRef]);

  // Reset for each new lobby.
  useEffect(() => {
    if (visible) {
      stagedRef.current = false;
      captionRef.current = '';
      setCaption('');
    }
  }, [visible, deadline]);

  // Ask for the camera on first open; a refusal is not fatal — the peer still takes part in the
  // wave, just without a moment (the same fallback the desktop has when getUserMedia fails).
  useEffect(() => {
    if (
      visible &&
      permission &&
      !permission.granted &&
      permission.canAskAgain
    ) {
      requestPermission();
    }
  }, [visible, permission, requestPermission]);

  // Countdown + auto-capture, on a self-rescheduling timeout (never setInterval).
  useEffect(() => {
    if (!visible) {
      return undefined;
    }
    let timer = null;
    // Don't burn the one capture while the OS permission dialog is still up — that would stage an
    // empty frame seconds before the user taps Allow. Wait it out, but never past the deadline:
    // at that point stage whatever we have (caption only) so the entry still posts.
    const awaitingPermission =
      !!permission && !permission.granted && permission.canAskAgain;
    const tick = () => {
      const msLeft = Math.max(0, (deadline || 0) - Date.now());
      const due = awaitingPermission
        ? msLeft <= 0
        : msLeft <= AUTO_CAPTURE_LEAD_MS;
      setSecsLeft(Math.ceil(msLeft / 1000));
      if (due && !stagedRef.current) {
        captureRef.current?.captureAndStage();
      }
      timer = setTimeout(tick, TICK_MS);
    };
    tick();
    return () => clearTimeout(timer);
  }, [visible, deadline, captureRef, permission]);

  if (!visible) {
    return null;
  }

  return (
    <Modal visible transparent animationType='fade'>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.title}>
            {busy ? '📸 capturing…' : `📸 your moment — ${secsLeft}s`}
          </Text>
          <View style={styles.previewWrap}>
            {permission?.granted ? (
              <CameraView
                ref={cameraRef}
                style={styles.preview}
                facing='front'
              />
            ) : (
              <Text style={styles.noCamera}>
                {permission?.canAskAgain === false
                  ? 'No camera access — you’ll ride the wave without a moment.'
                  : 'Waiting for camera permission…'}
              </Text>
            )}
          </View>
          <TextInput
            value={caption}
            onChangeText={(text) => {
              setCaption(text);
              captionRef.current = text;
            }}
            placeholder='Say something (optional)'
            placeholderTextColor={PALETTE.dim}
            maxLength={60}
            style={styles.caption}
          />
          <View style={styles.row}>
            <Pressable
              style={styles.capture}
              onPress={() => captureRef.current?.captureAndStage()}
            >
              <Text style={styles.captureText}>Capture now</Text>
            </Pressable>
            <Pressable style={styles.skip} onPress={onSkip}>
              <Text style={styles.skipText}>Skip</Text>
            </Pressable>
          </View>
          <Text style={styles.hint}>
            Auto-captures before the wave starts. Your moment posts when the
            sweep reaches your seat.
          </Text>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.85)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20
  },
  sheet: {
    width: '100%',
    backgroundColor: PALETTE.panel,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: PALETTE.orange,
    padding: 16,
    alignItems: 'center'
  },
  title: { color: PALETTE.text, fontSize: 17, fontWeight: '700' },
  previewWrap: {
    width: 240,
    height: 240,
    borderRadius: 120,
    overflow: 'hidden',
    marginVertical: 14,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center'
  },
  preview: { width: '100%', height: '100%' },
  noCamera: {
    color: PALETTE.muted,
    fontSize: 13,
    textAlign: 'center',
    paddingHorizontal: 18
  },
  caption: {
    width: '100%',
    padding: 10,
    borderRadius: 10,
    backgroundColor: PALETTE.bg,
    color: PALETTE.text
  },
  row: { flexDirection: 'row', gap: 12, marginTop: 12 },
  capture: {
    backgroundColor: PALETTE.orange,
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 10
  },
  captureText: { color: '#1a1204', fontWeight: '700' },
  skip: {
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: 10,
    backgroundColor: PALETTE.bg
  },
  skipText: { color: PALETTE.muted, fontWeight: '600' },
  hint: {
    color: PALETTE.muted,
    fontSize: 11,
    marginTop: 10,
    textAlign: 'center'
  }
});
