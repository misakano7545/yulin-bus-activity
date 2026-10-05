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
