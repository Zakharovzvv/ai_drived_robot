#include <Preferences.h>
#include "config.hpp"
#include "shelf_map.hpp"

Preferences prefs;
ShelfMap gShelf;

static ColorID parseColor(const String& token){
  String t = token; t.trim(); t.toUpperCase();
  if(t=="R") return C_RED;
  if(t=="G") return C_GREEN;
  if(t=="B") return C_BLUE;
  if(t=="Y") return C_YELLOW;
  if(t=="W") return C_WHITE;
  if(t=="K") return C_BLACK;
  return C_NONE;
}
static String colorToStr(ColorID c){
  switch(c){
    case C_RED: return "R";
    case C_GREEN: return "G";
    case C_BLUE: return "B";
    case C_YELLOW: return "Y";
    case C_WHITE: return "W";
    case C_BLACK: return "K";
    default: return "-";
  }
}

void ShelfMap::setDefault(){
  ColorID def[3][3] = {
    {C_BLACK, C_WHITE, C_YELLOW},
    {C_GREEN, C_BLUE,  C_RED   },
    {C_NONE,  C_NONE,  C_NONE  }
  };
  memcpy(map, def, sizeof(map));
}

void ShelfMap::fromString(const String& s){
  // format: "B,W,Y; G,B,R; -,-,-"
  int ri=0, ci=0; String token;
  for(size_t i=0;i<s.length() && ri<3;i++){
    char c = s[i];
    if(c==',' || c==';'){
      ColorID v = parseColor(token); map[ri][ci++] = v; token="";
      if(c==';'){ ri++; ci=0; }
    }else{
      token += c;
    }
  }
  if(ri<3 && token.length()){
    map[ri][ci] = parseColor(token);
  }
}
String ShelfMap::toString() const{
  String out;
  for(int r=0;r<3;r++){
    for(int c=0;c<3;c++){
      out += colorToStr(map[r][c]);
      if(c<2) out += ",";
    }
    if(r<2) out += "; ";
  }
  return out;
}

bool ShelfMap::loadNVS(){
  prefs.begin("rbm", true);
  String s = prefs.getString("shelf_map", "");
  prefs.end();
  if(s.length()==0){ setDefault(); return false; }
  fromString(s); return true;
}
bool ShelfMap::saveNVS() const{
  prefs.begin("rbm", false);
  bool ok = prefs.putString("shelf_map", toString())>0;
  prefs.end(); return ok;
}

void shelf_cli_process(Stream& io){
  if(!io.available()) return;
  String cmd = io.readStringUntil('\n'); cmd.trim();
  if(cmd.startsWith("SMAP get")){
    io.println(gShelf.toString()); return;
  }
  if(cmd.startsWith("SMAP set")){
    String s = cmd.substring(8); s.trim();
    gShelf.fromString(s); io.println("OK"); return;
  }
  if(cmd=="SMAP save"){ io.println(gShelf.saveNVS() ? "SAVED" : "FAIL"); return; }
  if(cmd=="SMAP clear"){ gShelf.setDefault(); io.println("RESET"); return; }
}