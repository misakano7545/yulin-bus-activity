package upstream

import (
	"bytes"
	"crypto/aes"
	"encoding/base64"
	"math"
	"testing"
)

// 真实向量：上游对 lineId=775200849296 的 cryptoSign。
func TestCryptoSign(t *testing.T) {
	got, err := cryptoSign(map[string]any{"lineId": "775200849296"})
	if err != nil {
		t.Fatal(err)
	}
	const want = "3f2031d13050245b1d39d5e90a824eca"
	if got != want {
		t.Fatalf("cryptoSign = %s, want %s", got, want)
	}
}

// ECB + PKCS7 往返：自己加密再解，验证块循环与去填充。
func TestDecryptECBRoundTrip(t *testing.T) {
	want := []byte(`{"lineId":"775200849296","buses":[]}`)
	got, err := decryptECB(encryptECB(t, want))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("往返不一致: got %q want %q", got, want)
	}
}

func TestDecryptECBRejectsGarbage(t *testing.T) {
	if _, err := decryptECB("not-base64!!"); err == nil {
		t.Fatal("坏 base64 应当报错")
	}
	if _, err := decryptECB(base64.StdEncoding.EncodeToString([]byte("short"))); err == nil {
		t.Fatal("非块对齐的密文应当报错")
	}
}

// 车辆在两站之间的插值比例。车与站同为 WGS 基准。
func TestSegPos(t *testing.T) {
	a := wireStop{Order: 1, WgsLat: 22.60, WgsLng: 110.15}
	b := wireStop{Order: 2, WgsLat: 22.61, WgsLng: 110.15}
	mid := (a.WgsLat + b.WgsLat) / 2

	cases := []struct {
		name     string
		lat, lng float64
		p, q     wireStop
		want     float64
		ok       bool
	}{
		{"在起点站", a.WgsLat, a.WgsLng, a, b, 0, true},
		{"在终点站", b.WgsLat, b.WgsLng, a, b, 1, true},
		{"正中", mid, a.WgsLng, a, b, 0.5, true},
		{"越过终点夹到 1", b.WgsLat + 0.1, b.WgsLng, a, b, 1, true},
		{"退回起点前夹到 0", a.WgsLat - 0.1, a.WgsLng, a, b, 0, true},
		{"站缺坐标 → 不可用", mid, a.WgsLng, a, wireStop{Order: 3}, 0, false},
		{"车缺坐标 → 不可用", 0, 0, a, b, 0, false},
	}
	for _, c := range cases {
		got, ok := segPos(c.lat, c.lng, c.p, c.q)
		if ok != c.ok || (ok && math.Abs(got-c.want) > 1e-6) {
			t.Errorf("%s: segPos = (%v,%v), want (%v,%v)", c.name, got, ok, c.want, c.ok)
		}
	}
}

// 上游站名笔误修正：命中才替换，未命中原样返回。
func TestFixStopName(t *testing.T) {
	cases := []struct{ in, want string }{
		{"高新产业园（玉林职业技术学院））", "高新产业园（玉林职业技术学院）"},
		{"高新产业园（玉林职业技术学院）", "高新产业园（玉林职业技术学院）"}, // 正确写法不动
		{"玉林火车站", "玉林火车站"},
	}
	for _, c := range cases {
		if got := fixStopName(c.in); got != c.want {
			t.Errorf("fixStopName(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func encryptECB(t *testing.T, plain []byte) string {
	t.Helper()
	block, err := aes.NewCipher([]byte(aesKey))
	if err != nil {
		t.Fatal(err)
	}
	n := aes.BlockSize - len(plain)%aes.BlockSize
	padded := append(append([]byte{}, plain...), bytes.Repeat([]byte{byte(n)}, n)...)
	out := make([]byte, len(padded))
	for i := 0; i < len(padded); i += aes.BlockSize {
		block.Encrypt(out[i:], padded[i:])
	}
	return base64.StdEncoding.EncodeToString(out)
}

// applyStopPosFix：上游把某站标在绕行支线上时，标记要挪到离 canonical 坐标最近的
// 折线点，且旧标记必须清掉（同 order 留两个点的话 trackIdx 取到的是后一个旧点）。
func TestApplyStopPosFix(t *testing.T) {
	track := [][3]float64{
		{110.143000, 22.628000, 0},
		{110.144400, 22.628800, 0}, // idx1：正线上、离 canonical 最近
		{110.143300, 22.628100, 0},
		{110.143436, 22.628088, 29}, // idx3：上游标的错点（支线上）
	}
	stops := []Stop{{Order: 29, Name: "人民大北路口"}}
	applyStopPosFix(track, "0775315346289", stops)

	if track[3][2] != 0 {
		t.Fatalf("旧标记没清掉：idx3 stopOrder=%v", track[3][2])
	}
	if track[1][2] != 29 {
		t.Fatalf("标记没挪到最近点：idx1 stopOrder=%v", track[1][2])
	}
	n := 0
	for _, p := range track {
		if p[2] == 29 {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("stopOrder 29 出现 %d 次，应当唯一", n)
	}

	// 修正表里没有的线路不受影响
	before := append([][3]float64(nil), track...)
	applyStopPosFix(track, "775200849296", stops)
	for i := range track {
		if track[i] != before[i] {
			t.Fatalf("无关线路被改动：idx%d %v -> %v", i, before[i], track[i])
		}
	}
}

// applyTrackCutFix：去掉「出去再折返」的伪迹段，A、B 两点都保留，其余线路不动。
func TestApplyTrackCutFix(t *testing.T) {
	track := [][3]float64{
		{110.144466, 22.628806, 29}, // 0 人民大北路口（站）
		{110.143778, 22.628384, 0},  // 1 A：路口，右转点
		{110.142771, 22.627826, 0},  // 2 ┐
		{110.142392, 22.627607, 0},  // 3 │ 出去再折返的伪迹
		{110.143436, 22.628088, 0},  // 4 │
		{110.143889, 22.628331, 0},  // 5 ┘ 折返回到主线的点
		{110.142830, 22.628905, 0},  // 6 B：右转后那条路的第一个点
		{110.142246, 22.629247, 0},  // 7
	}
	got := applyTrackCutFix(track, "0775315346289")
	want := [][3]float64{track[0], track[1], track[6], track[7]}
	if len(got) != len(want) {
		t.Fatalf("折线点数 = %d，期望 %d：%v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("idx%d = %v，期望 %v", i, got[i], want[i])
		}
	}
	// 折返段整体删净，不能只删出去那一半 —— 留一半等于把拐点搬到对向车道上
	for _, p := range got {
		if p == track[3] {
			t.Fatal("折返段最远点还在")
		}
	}

	// 修正表里没有的线路原样返回
	if other := applyTrackCutFix(track, "775200849296"); len(other) != len(track) {
		t.Fatalf("无关线路被改动：%d -> %d 点", len(track), len(other))
	}
}
