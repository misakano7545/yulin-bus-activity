package plate

import "testing"

func TestFleetNo(t *testing.T) {
	tab := &Table{m: map[string]string{"桂K12685D": "551"}}
	cases := []struct {
		licence, want string
		conf          bool
	}{
		{"433", "433", true},            // 纯数字 = 自编号
		{"桂K12685D", "551", true},       // 已知车牌
		{"桂K99999D", "桂K99999D", false}, // 未知车牌：原样透出并标低可信
	}
	for _, c := range cases {
		got, conf := tab.FleetNo(c.licence)
		if got != c.want || conf != c.conf {
			t.Errorf("FleetNo(%q) = (%q,%v), want (%q,%v)", c.licence, got, conf, c.want, c.conf)
		}
	}
}

// Lookup 是悄悄查表那条路：nil 表当空表、纯数字不查表，都不该 panic。
func TestLookup(t *testing.T) {
	var nilTab *Table
	if _, ok := nilTab.Lookup("桂K12685D"); ok {
		t.Error("nil 表应查不到")
	}
	tab := &Table{m: map[string]string{"桂K12685D": "551"}}
	if n, ok := tab.Lookup("桂K12685D"); !ok || n != "551" {
		t.Errorf("Lookup(已知车牌) = (%q,%v)", n, ok)
	}
	if _, ok := tab.Lookup("433"); ok {
		t.Error("纯数字不是表里的项，Lookup 应说没有")
	}
	if _, ok := tab.Lookup("桂K99999D"); ok {
		t.Error("表里没有的车牌应说没有")
	}
}

func TestLoadMissingFileGivesEmptyTable(t *testing.T) {
	tab, err := Load("no-such-file.json")
	if err == nil {
		t.Fatal("文件不存在应当报错")
	}
	if tab == nil || tab.Len() != 0 {
		t.Fatalf("应当返回空表, got %+v", tab)
	}
	if _, conf := tab.FleetNo("433"); !conf {
		t.Fatal("空表下纯数字 licence 仍应可信")
	}
}
