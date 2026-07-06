// Minimal HyperWave mobile UI — a SCAFFOLD proving the shared engine drives a React Native app
// through the worklet. It shows identity + peer count + wallet, lets you kick off / join a wave,
// and lists the gallery. The rich UI (the ring canvas + the rolling ⚽ + the centre-selfie
// player + camera capture) is the remaining RN work — see README "What's left".
import { useState } from 'react'
import {
  SafeAreaView,
  ScrollView,
  View,
  Text,
  Pressable,
  Image,
  StatusBar,
  StyleSheet
} from 'react-native'
import { useEngine } from './src/useEngine'

// Isolate this build's ring so multiple test devices don't collide on the public DHT.
const MATCH = 'hyperwave-mobile-demo'

export default function App() {
  // wallet on — testing WDK under the worklet (the chip populates on success; a failure
  // surfaces as a ⚠ wallet toast). Flip to wallet:false to run the engine wallet-less.
  const engine = useEngine({ matchId: MATCH })
  const { me, peers, phase, gallery, wallet, toast } = engine
  const [joined, setJoined] = useState(false)

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar barStyle='light-content' />
      <View style={styles.header}>
        <Text style={styles.title}>⚽ HyperWave</Text>
        <Text style={styles.chip}>
          {wallet ? `💰 ${wallet.trx} TRX · ${wallet.address.slice(0, 6)}…` : '💰 …'}
        </Text>
      </View>

      <View style={styles.status}>
        <Text style={styles.mono}>
          me {me ? `${me.id.slice(0, 8)} @ ${me.angle?.toFixed(1)}°` : '…'}
        </Text>
        <Text style={styles.mono}>
          peers {peers} · {phase}
        </Text>
      </View>

      <View style={styles.actions}>
        <Button label='Kick off a wave' onPress={engine.startWave} />
        <Button
          label={joined ? 'Joined' : 'Join wave'}
          disabled={joined}
          onPress={() => {
            engine.joinWave()
            setJoined(true)
          }}
        />
      </View>

      {toast ? <Text style={styles.toast}>{toast}</Text> : null}

      <Text style={styles.section}>Gallery ({gallery.length})</Text>
      <ScrollView contentContainerStyle={styles.gallery}>
        {gallery.map((g, i) => (
          <View key={i} style={styles.card}>
            {g.image ? <Image source={{ uri: g.image }} style={styles.thumb} /> : null}
            <Text style={styles.caption}>{g.caption || g.peerId?.slice(0, 8) || 'selfie'}</Text>
            {g.address ? (
              <Pressable onPress={() => engine.tip(g.address, 1)}>
                <Text style={styles.tip}>💵 Tip 1 TRX</Text>
              </Pressable>
            ) : null}
          </View>
        ))}
      </ScrollView>
    </SafeAreaView>
  )
}

function Button({ label, onPress, disabled }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[styles.btn, disabled && styles.btnDisabled]}
    >
      <Text style={styles.btnText}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0b1020' },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16
  },
  title: { color: '#fff', fontSize: 22, fontWeight: '700' },
  chip: { color: '#9ecbff', fontSize: 13 },
  status: { paddingHorizontal: 16, gap: 4 },
  mono: { color: '#8aa0c0', fontFamily: 'Courier', fontSize: 13 },
  actions: { flexDirection: 'row', gap: 12, padding: 16 },
  btn: { backgroundColor: '#2b6cff', paddingVertical: 12, paddingHorizontal: 16, borderRadius: 10 },
  btnDisabled: { backgroundColor: '#33415c' },
  btnText: { color: '#fff', fontWeight: '600' },
  toast: { color: '#ffd479', paddingHorizontal: 16, paddingBottom: 8 },
  section: { color: '#fff', fontSize: 16, fontWeight: '600', paddingHorizontal: 16, paddingTop: 8 },
  gallery: { padding: 16, gap: 12 },
  card: { backgroundColor: '#141a2e', borderRadius: 12, padding: 12, alignItems: 'center' },
  thumb: { width: 160, height: 160, borderRadius: 8, marginBottom: 8 },
  caption: { color: '#cfe0ff' },
  tip: { color: '#7dffa1', marginTop: 6 }
})
